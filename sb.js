/* ============================================================
 *  Supabase REST 数据层（原生 fetch，不依赖任何 SDK）
 *
 *  安全模型（关键点）：
 *    - anon key 只有 INSERT 权限，不能 SELECT / UPDATE / DELETE
 *      → 参与者只能写自己的结果，永远看不到别人的（即使抓包也读不到）
 *    - draws.name 是唯一索引 → 同名第二次写入被数据库拒绝 = "仅可抽一次"
 *    - choices.draw_id 唯一 → 一次抽签只能选择一次
 *    - 只有持有 service_role key 的管理端才能读取全量
 * ============================================================ */
(function (global) {
  'use strict';

  var K_URL = 'sb_lottery_url';
  var K_ANON = 'sb_lottery_anon';
  var K_SVC = 'sb_lottery_service';

  var SCENES = [
    { id: 1, name: '场景一 制造业' },
    { id: 2, name: '场景二 建筑服务业' },
    { id: 3, name: '场景三 零售业' },
    { id: 4, name: '场景四 生活服务业' }
  ];

  function ls(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }

  /* 从 URL hash 读取链接自带配置：#u=<url>&k=<anon>&s=<service_role(可选，管理员专用)> */
  function fromHash() {
    try {
      var h = (location.hash || '').replace(/^#/, '');
      if (!h) return null;
      var p = new URLSearchParams(h);
      var u = p.get('u'), k = p.get('k'), s = p.get('s');
      if (u && k) { lsSet(K_URL, u); lsSet(K_ANON, k); if (s) lsSet(K_SVC, s); return { url: u, anon: k, svc: s || '' }; }
    } catch (e) { }
    return null;
  }

  function cfg() {
    var file = global.LOTTERY_CONFIG || {};
    var h = fromHash();
    return {
      url: (h && h.url) || ls(K_URL) || (file.SUPABASE_URL || '').replace(/\/+$/, ''),
      anon: (h && h.anon) || ls(K_ANON) || (file.SUPABASE_ANON || ''),
      svc: (h && h.svc) || ls(K_SVC)
    };
  }

  function ready() { var c = cfg(); return !!(c.url && c.anon); }
  function saveAuth(url, anon, svc) {
    // 容错：去掉误粘贴的尾巴（/rest/v1、/storage/v1 等）和尾部斜杠
    url = (url || '').trim().replace(/\/+$/, '').replace(/\/(rest|storage|auth|realtime|functions)\/v\d+$/i, '');
    lsSet(K_URL, url);
    if (anon) lsSet(K_ANON, anon.trim());
    if (svc !== undefined) lsSet(K_SVC, (svc || '').trim());
  }
  function clearAuth() {
    try { localStorage.removeItem(K_URL); localStorage.removeItem(K_ANON); localStorage.removeItem(K_SVC); } catch (e) { }
  }
  function shareUrl() {
    var c = cfg();
    if (!ready()) return location.href;
    var base = location.href.split('#')[0];
    return base + '#u=' + encodeURIComponent(c.url) + '&k=' + encodeURIComponent(c.anon);
  }

  function pickTwo() {
    var pool = SCENES.slice(), out = [];
    for (var i = 0; i < 2; i++) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return out;
  }

  function rest(c) { return c.url + '/rest/v1'; }

  function req(c, path, opts) {
    opts = opts || {};
    var headers = {
      'apikey': opts.key,
      'Authorization': 'Bearer ' + opts.key,
      'Content-Type': 'application/json'
    };
    if (opts.represent) headers['Prefer'] = 'return=representation';
    if (opts.prefer) headers['Prefer'] = opts.prefer;
    var conf = { method: opts.method || 'GET', headers: headers };
    if (opts.body) conf.body = JSON.stringify(opts.body);
    // 关键：apikey 同时放进查询参数。部分浏览器/代理会拦截自定义请求头，
    // 导致钥匙丢失报 401；查询参数不受影响，双保险。
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    return fetch(rest(c) + path + sep + 'apikey=' + encodeURIComponent(opts.key), conf).then(async (r) => {
      var text = await r.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { }
      if (!r.ok) {
        if (r.status === 409) return { conflict: true, raw: data, status: r.status };
        var msg = (data && (data.message || data.msg || data.hint || data.error)) || ('请求失败 HTTP ' + r.status);
        if (r.status === 401 || r.status === 403) msg = '密钥被 Supabase 拒绝（' + r.status + '）：请回到 API Keys 页面，用每把 key 右边的【复制按钮】重新复制完整 key（手动划选文字容易漏掉头尾字符）；同时核对 Project URL 是否和浏览器地址栏 dashboard/project/ 后面那串完全一致';
        return { error: msg, status: r.status, raw: data };
      }
      return { data: data };
    }).catch((e) => ({ error: '网络异常，请检查网络后重试（' + (e.message || '无法连接 Supabase') + '）' }));
  }

  /* ---------------- 抽签页（anon key，仅写入） ---------------- */

  // 由前端生成 uuid：RLS 下 anon 没有 SELECT 权限时，Postgres 的
  // INSERT ... RETURNING 会返回空行，所以不能依赖服务端返回的 id
  function genId() {
    try {
      if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    } catch (e) { }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var r = (Math.random() * 16) | 0, v = ch === 'x' ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }

  async function draw(name) {
    var c = cfg();
    if (!ready()) return { ok: false, msg: '尚未完成云端配置' };
    name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    if (!name) return { ok: false, msg: '请先填写抽签人姓名' };

    var scenes = pickTwo();
    var drawId = genId();
    var r = await req(c, '/lottery_draws', {
      method: 'POST', key: c.anon,
      body: { id: drawId, name: name, scene_a: scenes[0].id, scene_b: scenes[1].id }
    });

    if (r.conflict) return { ok: false, msg: '该姓名已经抽过签啦，每人仅可抽取一次~' };
    if (r.error) {
      if (r.status === 404) return { ok: false, msg: '云端数据表不存在，请先在 Supabase 执行建表 SQL' };
      if (r.status === 401 || r.status === 403) return { ok: false, msg: '写入被拒绝（401/403）：请确认 Supabase 里执行过最新的 granting 脚本' };
      return { ok: false, msg: r.error };
    }
    return { ok: true, drawId: drawId, name: name, scenes: scenes };
  }

  async function choose(drawId, name, sceneId) {
    var c = cfg();
    if (!ready()) return { ok: false, msg: '尚未完成云端配置' };
    var r = await req(c, '/lottery_choices', {
      method: 'POST', key: c.anon,
      body: { draw_id: drawId, name: name, scene_id: sceneId }
    });
    if (r.conflict) return { ok: false, msg: '本次抽签已完成选择' };
    if (r.error) {
      if (r.status === 401 || r.status === 403) return { ok: false, msg: '写入被拒绝（401/403）：请确认 Supabase 里执行过最新的 granting 脚本' };
      return { ok: false, msg: r.error };
    }
    return { ok: true, record: { draw_id: drawId, scene_id: sceneId } };
  }

  /* ---------------- 管理端（service_role key，可读可删） ---------------- */

  function key() {
    var c = cfg();
    return c.svc || c.anon;
  }

  async function listAll() {
    var c = cfg();
    if (!ready()) return { ok: false, msg: '尚未完成云端配置' };
    var d = await req(c, '/lottery_draws?select=id,name,scene_a,scene_b,created_at&order=created_at.asc', { key: key() });
    if (d.error) {
      if (d.status === 401 || d.status === 403) {
        return {
          ok: false,
          msg: '密钥权限不足（' + d.status + '）：' + (d.error || '') +
            '　请点 Supabase 后台 → Project Settings → API Keys 里 Secret key 那行的「复制」图标，重新贴一次（不要手划选文字）'
        };
      }
      return { ok: false, msg: d.error };
    }
    var ch = await req(c, '/lottery_choices?select=id,draw_id,name,scene_id,created_at', { key: key() });
    if (ch.error) return { ok: false, msg: ch.error };

    var map = {}; (ch.data || []).forEach(function (x) { map[x.draw_id] = x; });
    var sceneOf = function (id) { for (var i = 0; i < SCENES.length; i++) if (SCENES[i].id === id) return SCENES[i]; return null; };

    var records = (d.data || []).map(function (r) {
      var pick = map[r.id];
      return {
        id: r.id,
        name: r.name,
        scenes: [sceneOf(r.scene_a), sceneOf(r.scene_b)].filter(Boolean),
        chosen: pick ? sceneOf(pick.scene_id) : null,
        createdAt: r.created_at,
        chosenAt: pick ? pick.created_at : null
      };
    });
    return { ok: true, records: records, scenes: SCENES, usingService: !!c.svc };
  }

  /* 无需管理员钥匙的结果读取：调用库里建好的 lottery_results() 视图函数。
     只要页面带着公开的 anon key（已写进 config.js），谁打开都能看到，不必填任何东西。 */
  async function listPublic() {
    var c = cfg();
    var file = global.LOTTERY_CONFIG || {};
    var anonKey = c.anon || (file.SUPABASE_ANON || '');
    if (!c.url) return { ok: false, msg: '页面缺少 Supabase 地址配置' };
    if (!anonKey) return { ok: false, msg: '页面缺少 anon key 配置' };
    var r = await req(c, '/rpc/lottery_results', { key: anonKey });
    if (r.error) {
      return {
        ok: false,
        msg: r.error,
        status: r.status,
        raw: r.raw,
        hint: (r.status === 404)
          ? '数据库里还没有 lottery_results() 这个函数，请到 Supabase → SQL Editor 执行一遍「免密钥读取.sql」'
          : ('HTTP ' + r.status)
      };
    }
    var sceneOf = function (id) { for (var i = 0; i < SCENES.length; i++) if (SCENES[i].id === id) return SCENES[i]; return null; };
    var records = (r.data || []).map(function (x) {
      return {
        id: null,
        name: x.name,
        scenes: [sceneOf(x.scene_a), sceneOf(x.scene_b)].filter(Boolean),
        chosen: x.scene_id ? sceneOf(x.scene_id) : null,
        createdAt: x.drew_at,
        chosenAt: x.chose_at
      };
    });
    return { ok: true, records: records, scenes: SCENES };
  }

  async function remove(drawId) {
    var c = cfg();
    // 外键为 ON DELETE CASCADE，choices 会自动清理
    var r = await req(c, '/lottery_draws?id=eq.' + drawId, { method: 'DELETE', key: key() });
    if (r.error) {
      if (r.status === 401 || r.status === 403) return { ok: false, msg: '密钥权限不足，需 service_role key' };
      return { ok: false, msg: r.error };
    }
    return { ok: true };
  }

  async function resetAll() {
    var c = cfg();
    var r = await req(c, '/lottery_draws?id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE', key: key() });
    if (r.error) return { ok: false, msg: (r.status === 401 || r.status === 403) ? '密钥权限不足，需 service_role key' : r.error };
    return { ok: true };
  }

  global.SB = {
    SCENES: SCENES, cfg: cfg, ready: ready, saveAuth: saveAuth, clearAuth: clearAuth,
    shareUrl: shareUrl, draw: draw, choose: choose, listAll: listAll, listPublic: listPublic, remove: remove, resetAll: resetAll
  };
})(window);
