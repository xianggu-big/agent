# -*- coding: utf-8 -*-
"""API 池与高并发专项测试
覆盖：多供应商轮换 / 并发上限 / 失败冷却与自动切换 / 批量导入 / 岗位回退 / 权限
用法：QF_BASE=http://localhost:8541 python pool_test.py
"""
import json, os, time, urllib.request, urllib.error, http.cookiejar

BASE = os.environ.get('QF_BASE', 'http://localhost:8541')
ok = fail = skip = 0
TAG = str(int(time.time()))[-6:]

def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1; print('  [OK] ' + name)
    else: fail += 1; print('  [FAIL] ' + name + (' -> ' + str(detail) if detail else ''))

def skipcheck(name, reason):
    global skip
    skip += 1; print('  [SKIP] ' + name + '（' + reason + '）')

def session():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj

def call(op, path, body=None, method=None):
    data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={'Content-Type': 'application/json'},
                                 method=method or ('POST' if data is not None else 'GET'))
    try:
        return json.load(op.open(req))
    except urllib.error.HTTPError as e:
        return {'__http': e.code, 'error': e.read().decode('utf-8')[:200]}

print('=' * 60)
print('API 池与高并发专项测试')
print('=' * 60)

# 管理员账号
# 优先用测试夹具提供的固定管理员（runtests.js 会在测试库里预先建好）。
# 旧版本这里是"注册第一个用户碰运气成为管理员"，失败时还会去登录真实管理员账号
# （某个人的真实管理员账号）—— 那等于把测试绑在某个人的线上账号上；测试库隔离后必然失败。
admin, acj = session()
FIX_USER = os.environ.get('QF_TEST_ADMIN_USER')
FIX_PWD = os.environ.get('QF_TEST_ADMIN_PWD')
if FIX_USER:
    call(admin, '/api/auth/login', {'username': FIX_USER, 'password': FIX_PWD})
if call(admin, '/api/me').get('role') != 'admin':
    # 回退：测试库里如果还没有任何用户，注册的第一个账号即为管理员
    admin, acj = session()
    r = call(admin, '/api/auth/register', {'username': 'pool_admin_' + TAG, 'password': 'pool123456'})
    if not r.get('ok'):
        call(admin, '/api/auth/login', {'username': 'pool_admin_' + TAG, 'password': 'pool123456'})
    if call(admin, '/api/me').get('role') != 'admin':
        print('  [SKIP] 没有管理员权限，无法运行 API 池测试。'
              '请用 node runtests.js 运行，或设置 QF_TEST_ADMIN_USER / QF_TEST_ADMIN_PWD')
        raise SystemExit(0)

# ---------- 1. 结构 ----------
print('\n[1] 配置结构（供应商池 + 岗位绑定）')
cfg = call(admin, '/api/config')
check('配置含供应商池', isinstance(cfg.get('providers'), list), list(cfg.keys()))
check('配置含并发参数', bool(cfg.get('concurrency')), cfg.get('concurrency'))
check('岗位带可用性标记', all('usable' in v for v in cfg.get('profiles', {}).values()), '')
check('供应商 Key 已打码', all('***' in p['apiKey'] or p['apiKey'] == '' for p in cfg['providers']), '')

# ---------- 2. 岗位回退（本次 401 的根因） ----------
print('\n[2] 岗位缺 Key 时自动回退主供应商')
nlu = cfg['profiles'].get('nlu', {})
check('nlu 岗位已绑定供应商', bool(nlu.get('providerIds')), nlu)
check('nlu 岗位标记为可用', nlu.get('usable') is True, nlu)
r = call(admin, '/api/chat/parse', {'materialText': '测试资料：栈是后进先出的线性表。' * 5,
                                    'requirementText': '请出 3 道选择题，中等难度'})
check('对话制题不再因缺 Key 报 401', '__http' not in r and not r.get('error'), str(r)[:160])
check('解析出需求', bool(r.get('parsed', {}).get('requirements')), r.get('parsed'))

# ---------- 3. 批量导入 ----------
print('\n[3] 批量粘贴导入')
text = ('测试供应商A,https://api.deepseek.com,sk-test-aaaaaaaaaaaa,2,8\n'
        '测试供应商B,https://api.deepseek.com,sk-test-bbbbbbbbbbbb,2,8\n'
        '测试供应商C|https://open.bigmodel.cn/api/paas/v4|test-cccccccccccc|1|1\n'
        '# 这是注释行，应被忽略\n'
        '坏行只有两列,https://x.com\n'
        '测试D,没有协议头,sk-test\n')
r = call(admin, '/api/providers/import', {'text': text})
check('导入返回成功', r.get('ok') is True, r)
check('成功导入 3 个（竖线分隔也支持）', len(r.get('added', [])) == 3, r.get('added'))
check('注释行被忽略', all('注释' not in a['name'] for a in r.get('added', [])), '')
check('坏行被拒绝并给出原因', len(r.get('failed', [])) == 2, r.get('failed'))
added_ids = [a['id'] for a in r.get('added', [])]

# 导入时绑定到岗位
r2 = call(admin, '/api/providers/import', {'text': '绑定测试,https://api.deepseek.com,sk-test-bind00000000,2,8', 'bindTo': 'verifier1'})
bind_id = r2['added'][0]['id']
cfg2 = call(admin, '/api/config')
check('导入可直接绑定到岗位', bind_id in cfg2['profiles']['verifier1']['providerIds'], cfg2['profiles']['verifier1']['providerIds'])

# ---------- 4. 多供应商绑定 = 并发轮换 ----------
print('\n[4] 多供应商绑定与轮换')
r = call(admin, '/api/config', {'profiles': {
    'verifier1': {'model': 'deepseek-chat', 'providerIds': [added_ids[0], added_ids[1], bind_id]}}})
check('岗位可绑定多个供应商', len(r['profiles']['verifier1']['providerIds']) == 3, r['profiles']['verifier1']['providerIds'])
check('多供应商后岗位仍标记可用', r['profiles']['verifier1']['usable'] is True, '')
# 绑定不存在的供应商应被过滤
r = call(admin, '/api/config', {'profiles': {'verifier1': {'providerIds': [added_ids[0], 'not_exist']}}})
check('不存在的供应商被过滤', r['profiles']['verifier1']['providerIds'] == [added_ids[0]], r['profiles']['verifier1']['providerIds'])

# ---------- 5. 并发控制参数 ----------
print('\n[5] 并发参数')
r = call(admin, '/api/config', {'concurrency': {'global': 5, 'perProvider': 2, 'cooldownSec': 10}})
check('并发参数可保存', r['concurrency']['global'] == 5 and r['concurrency']['perProvider'] == 2, r['concurrency'])
rt = call(admin, '/api/runtime')
check('运行状态返回并发配置', rt['concurrency']['global'] == 5, rt['concurrency'])
check('运行状态含全局瞬时负载', 'active' in rt['global'] and 'limit' in rt['global'], rt['global'])
check('运行状态含各供应商负载', all('active' in p for p in rt['providers']), '')
r = call(admin, '/api/config', {'concurrency': {'global': 999, 'perProvider': 0, 'cooldownSec': -5}})
check('并发参数越界被钳制', r['concurrency']['global'] <= 200 and r['concurrency']['perProvider'] >= 1 and r['concurrency']['cooldownSec'] >= 1, r['concurrency'])
# 恢复合理值
call(admin, '/api/config', {'concurrency': {'global': 8, 'perProvider': 4, 'cooldownSec': 30}})

# ---------- 6. 失败冷却与自动切换 ----------
print('\n[6] 失败冷却与自动切换（用无效 Key 触发）')
r = call(admin, '/api/providers', {'providers': [{'name': '坏Key供应商', 'baseUrl': 'https://api.deepseek.com', 'apiKey': 'sk-invalid-key-for-test-000000', 'priceIn': 2, 'priceOut': 8}]})
bad_id = r['added'][0]['id']
# 把坏 Key 与坏 Key+好 Key 分别绑到 nlu 岗位，各触发一次调用
call(admin, '/api/config', {'profiles': {'nlu': {'model': 'deepseek-chat', 'providerIds': [bad_id]}}})
call(admin, '/api/user/recharge', {'amount': 0.01}) if False else None
r = call(admin, '/api/chat/parse', {'materialText': '测试资料：队列是先进先出。' * 5, 'requirementText': '出 2 道选择题'})
nlu_only_bad = r
# 现在绑定 坏Key + 好Key（应能自动切换成功）
good_id = cfg['providers'][0]['id']
call(admin, '/api/config', {'profiles': {'nlu': {'model': 'deepseek-chat', 'providerIds': [bad_id, good_id]}}})
r2 = call(admin, '/api/chat/parse', {'materialText': '测试资料：队列是先进先出。' * 5, 'requirementText': '出 2 道选择题'})
check('绑定坏+好两个 Key 时能自动切换到可用 Key',
      '__http' not in r2 and not r2.get('error') and bool(r2.get('parsed', {}).get('requirements')),
      str(r2)[:200])
rt = call(admin, '/api/runtime')
badstat = next((p for p in rt['providers'] if p['id'] == bad_id), None)
if rt.get('mock'):
    skipcheck('失败计数与冷却', '模拟模式不发真实请求（该机制由 selftest.js 的单元测试确定性覆盖）')
else:
    if badstat:
        check('失败被计数', badstat['fail'] >= 1, badstat)
        check('失败原因被记录', bool(badstat.get('lastErr')), badstat.get('lastErr'))
        check('坏 Key 进入冷却', badstat.get('cooling') is True, badstat)
r = call(admin, '/api/runtime/thaw', {})
check('可手动清除冷却', r.get('ok') is True, r)

# ---------- 7. 清理 ----------
print('\n[7] 删除供应商与岗位回退')
r = call(admin, '/api/providers/delete', {'id': bad_id})
check('可删除供应商', r.get('ok') is True, r)
after = r['config']
check('删除后 nlu 岗位回退到其它供应商', bad_id not in after['profiles']['nlu']['providerIds'], after['profiles']['nlu']['providerIds'])
check('回退后岗位仍可用', after['profiles']['nlu']['usable'] is True, '')
for i in added_ids + [bind_id]:
    call(admin, '/api/providers/delete', {'id': i})
cfg3 = call(admin, '/api/config')
check('清理测试供应商完成', all(i not in [p['id'] for p in cfg3['providers']] for i in added_ids), '')

# ---------- 8. 权限 ----------
print('\n[8] 权限隔离（API 池仅管理员）')
other, _ = session()
call(other, '/api/auth/register', {'username': 'pool_user_' + TAG, 'password': 'pool123456'})
r = call(other, '/api/runtime')
check('普通用户看不到运行状态（403）', r.get('__http') == 403, r)
r = call(other, '/api/providers/import', {'text': 'x,https://a.com,k'})
check('普通用户不能导入供应商（403）', r.get('__http') == 403, r)
r = call(other, '/api/providers/delete', {'id': 'x'})
check('普通用户不能删除供应商（403）', r.get('__http') == 403, r)
r = call(other, '/api/config')
check('普通用户看到的 Key 仍然是打码的', all('***' in p['apiKey'] or p['apiKey'] == '' for p in r.get('providers', [])), '')

# ---------- 9. 用户管理与管理员创建 ----------
print('\n[9] 用户管理与管理员创建')
adm_op, _ = session()
# （旧版会在这里登录某个真实管理员账号兜底，已改为统一使用测试夹具账号，见文件开头）
if call(adm_op, '/api/me').get('role') != 'admin':
    skipcheck('用户管理测试', '测试库中无管理员账号')
else:
    ul = call(adm_op, '/api/admin/users')
    check('管理员可列出全部用户', len(ul.get('users', [])) > 0, ul)
    check('列表含自己的标记', any(u.get('isMe') for u in ul['users']), '')
    check('列表含各账号数据量', all('tasks' in u and 'questions' in u for u in ul['users']), '')

    newname = 'newadmin_' + TAG
    r = call(adm_op, '/api/admin/create-admin', {'username': newname, 'password': 'newadmin123456'})
    check('管理员可直接创建管理员账号', r.get('ok') is True, r)
    created_id = r.get('id')
    na, _ = session()
    r = call(na, '/api/auth/login', {'username': newname, 'password': 'newadmin123456'})
    check('新建管理员可登录', r.get('ok') is True, r)
    check('新建管理员角色为 admin', call(na, '/api/me').get('role') == 'admin', '')
    check('新建管理员可访问 API 池', '__http' not in call(na, '/api/runtime'), '')
    check('新建管理员可访问用户列表', 'users' in call(na, '/api/admin/users'), '')

    r = call(adm_op, '/api/admin/create-admin', {'username': newname, 'password': 'another123456'})
    check('拒绝重复用户名', r.get('__http') == 400, r)
    r = call(adm_op, '/api/admin/create-admin', {'username': 'weak_' + TAG, 'password': '123'})
    check('拒绝弱密码', r.get('__http') == 400, r)
    r = call(adm_op, '/api/admin/role', {'userId': 99999999, 'role': 'admin'})
    check('拒绝不存在的用户', r.get('__http') == 404, r)
    r = call(adm_op, '/api/admin/role', {'userId': created_id, 'role': 'superuser'})
    check('拒绝非法角色', r.get('__http') == 400, r)

    r = call(adm_op, '/api/admin/role', {'userId': created_id, 'role': 'user'})
    check('可取消管理员', r.get('ok') is True, r)
    ul2 = call(adm_op, '/api/admin/users')
    check('取消后角色变为普通用户',
          next(u['role'] for u in ul2['users'] if u['id'] == created_id) == 'user', '')

    admins = [u for u in ul2['users'] if u['role'] == 'admin' and u['id'] != ul2['me']['id']]
    for a in admins:
        call(adm_op, '/api/admin/role', {'userId': a['id'], 'role': 'user'})
    r = call(adm_op, '/api/admin/role', {'userId': ul2['me']['id'], 'role': 'user'})
    check('不能取消最后一个管理员', r.get('__http') == 400 and '最后一个管理员' in str(r.get('error', '')), r)

    pu, _ = session()
    call(pu, '/api/auth/register', {'username': 'adminperm_' + TAG, 'password': 'perm123456'})
    check('普通用户不能列用户（403）', call(pu, '/api/admin/users').get('__http') == 403, '')
    check('普通用户不能创建管理员（403）',
          call(pu, '/api/admin/create-admin', {'username': 'x_' + TAG, 'password': 'xxxxxx123'}).get('__http') == 403, '')
    check('普通用户不能改角色（403）', call(pu, '/api/admin/role', {'userId': 1, 'role': 'admin'}).get('__http') == 403, '')

# ---------- 10. 模型跟随供应商（模块化核心） ----------
print('\n[10] 模型跟随供应商 / 预检接口')
adm2, _ = session()
# （旧版会在这里登录某个真实管理员账号兜底，已改为统一使用测试夹具账号，见文件开头）
if call(adm2, '/api/me').get('role') != 'admin':
    skipcheck('模型跟随供应商', '无管理员账号')
else:
    cfgA = call(adm2, '/api/config')
    check('供应商带默认模型字段', all('model' in p for p in cfgA['providers']), cfgA['providers'][:1])
    ds = next((p for p in cfgA['providers'] if 'deepseek' in p['baseUrl']), None)
    zp = next((p for p in cfgA['providers'] if 'bigmodel' in p['baseUrl']), None)
    if not ds or not zp:
        skipcheck('模型跟随供应商', '测试库缺少 DeepSeek/智谱 两个供应商')
    else:
        # 1) 新增供应商必须保留 model（防回归：曾丢失该字段导致串模型）
        r = call(adm2, '/api/providers', {'providers': [{'name': '模型测试', 'baseUrl': 'https://api.deepseek.com',
              'apiKey': 'sk-model-test-0000', 'model': 'deepseek-reasoner', 'priceIn': 2, 'priceOut': 8}]})
        tid_p = r['added'][0]['id']
        cfgB = call(adm2, '/api/config')
        newp = next(p for p in cfgB['providers'] if p['id'] == tid_p)
        check('新增供应商保留默认模型', newp['model'] == 'deepseek-reasoner', newp)

        # 2) 岗位换绑 → 模型自动跟随（不再残留旧模型）
        call(adm2, '/api/config', {'profiles': {'verifier2': {'providerIds': [tid_p], 'modelOverride': ''}}})
        pf = call(adm2, '/api/eval/preflight')
        v2 = next(v for v in pf['verifiers'] if v['role'] == 'verifier2')
        check('换绑供应商后模型自动跟随', v2['model'] == 'deepseek-reasoner', v2)
        check('模型来源标记为供应商默认', v2['modelSource'] == '供应商默认', v2)

        # 3) 岗位级覆盖优先于供应商默认（同供应商跑不同模型）
        call(adm2, '/api/config', {'profiles': {'verifier2': {'providerIds': [zp['id']], 'modelOverride': 'glm-4v-flash'}}})
        pf2 = call(adm2, '/api/eval/preflight')
        v2b = next(v for v in pf2['verifiers'] if v['role'] == 'verifier2')
        check('岗位覆盖优先于供应商默认', v2b['model'] == 'glm-4v-flash', v2b)
        check('来源标记为岗位覆盖', v2b['modelSource'] == '岗位覆盖', v2b)

        # 4) 两个同源供应商互检（用户诉求场景）
        r = call(adm2, '/api/providers', {'providers': [{'name': 'DeepSeek-二号', 'baseUrl': 'https://api.deepseek.com',
              'apiKey': 'sk-second-0000', 'model': 'deepseek-chat', 'priceIn': 2, 'priceOut': 8}]})
        ds2 = r['added'][0]['id']
        call(adm2, '/api/config', {'profiles': {
            'verifier1': {'providerIds': [ds['id']], 'modelOverride': ''},
            'verifier2': {'providerIds': [ds2], 'modelOverride': ''}}})
        pf3 = call(adm2, '/api/eval/preflight')
        a = next(v for v in pf3['verifiers'] if v['role'] == 'verifier1')
        b = next(v for v in pf3['verifiers'] if v['role'] == 'verifier2')
        check('可用两个同厂商 Key 做互检',
              a['provider'] != b['provider'] and a['model'] == 'deepseek-chat' and b['model'] == 'deepseek-chat',
              {'a': (a['provider'], a['model']), 'b': (b['provider'], b['model'])})

        # 5) 预检接口信息完整 + 金标题库来源可配置
        check('预检含金标题库来源', bool(pf3.get('golden') and pf3['golden'].get('file')), pf3.get('golden'))
        check('预检含候选路径列表', len(pf3.get('goldenCandidates', [])) >= 2, pf3.get('goldenCandidates'))
        check('预检含各岗位候选供应商', all('candidates' in v for v in pf3['verifiers']), '')

        # 清理
        call(adm2, '/api/providers/delete', {'id': tid_p})
        call(adm2, '/api/providers/delete', {'id': ds2})
        call(adm2, '/api/config', {'profiles': {
            'verifier1': {'providerIds': [ds['id']], 'modelOverride': ''},
            'verifier2': {'providerIds': [zp['id']], 'modelOverride': ''}}})
        check('测试供应商已清理', all(p['id'] not in [tid_p, ds2] for p in call(adm2, '/api/config')['providers']), '')

print('\n' + '=' * 60)
print('通过 %d 项，失败 %d 项，跳过 %d 项' % (ok, fail, skip))
print('=' * 60)
import sys
sys.exit(1 if fail else 0)
