# -*- coding: utf-8 -*-
"""资料库取材专项测试：验证「对话制题」「精确制题」都能引用资料库资料
覆盖：上传入库 → 列表/详情/图片 → 对话制题取材 → 精确制题取材 → 原图关联与内嵌 → 隔离 → 删除
"""
import json, time, urllib.request, urllib.error, http.cookiejar

import os, sys
BASE = os.environ.get('QF_BASE', 'http://localhost:8541')  # 测试独立端口，不影响正在使用的服务

# ---------- 测试资料文件（仓库自带合成夹具，见 testdata/make_fixture.py） ----------
# 旧写法直接 open('../19—25年852真题及答案.pdf')：那是本机才有的真实资料，不在仓库里，
# 于是 GitHub Actions 上必然 FileNotFoundError（data/ 与兄弟目录都被排除在版本控制外）。
# 现在按优先级查找，并允许用 QF_TEST_PDF 指定真实资料做更贴近实际的验证。
HERE = os.path.dirname(os.path.abspath(__file__))
def _find_sample_pdf():
    for c in (os.environ.get('QF_TEST_PDF'),
              os.path.join(HERE, 'testdata', 'sample.pdf'),
              os.path.join(HERE, '..', '19—25年852真题及答案.pdf')):
        if c and os.path.isfile(c):
            return os.path.abspath(c)
    return None
SAMPLE_PDF = _find_sample_pdf()
if not SAMPLE_PDF:
    print('✗ 找不到测试用 PDF。请先在项目根目录执行：python testdata/make_fixture.py')
    print('  （或用环境变量 QF_TEST_PDF 指定一个真实资料文件）')
    sys.exit(1)
ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1; print('  [OK] ' + name)
    else: fail += 1; print('  [FAIL] ' + name + (' -> ' + str(detail) if detail else ''))

def session():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj

def call(op, path, body=None, method=None, raw=None):
    data = raw if raw is not None else (json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data,
        headers={'Content-Type': 'application/json'}, method=method or ('POST' if data is not None else 'GET'))
    try:
        return json.load(op.open(req))
    except urllib.error.HTTPError as e:
        return {'__http': e.code, 'error': e.read().decode('utf-8')[:200]}

def wait_task(op, tid, limit=60):
    for _ in range(limit):
        time.sleep(1)
        d = call(op, '/api/tasks/' + tid)
        if d.get('task', {}).get('status') in ('awaiting_review', 'completed', 'paused_error', 'paused_budget'):
            return d
    return d

print('=' * 60)
print('资料库取材专项测试')
print('=' * 60)

admin, _ = session()
u = 'libtest_' + str(int(time.time()))[-6:]
call(admin, '/api/auth/register', {'username': u, 'password': 'libtest123'})
call(admin, '/api/user/recharge', {'amount': 50})
print('\n[准备] 测试账号 %s 已就绪，余额已充值' % u)

# ---------- 1. 上传入库 ----------
print('\n[1] 资料上传与入库')
pdf = open(SAMPLE_PDF, 'rb').read()
d = call(admin, '/api/parse?name=lib_test.pdf', raw=pdf)
check('PDF 解析成功', bool(d.get('ok')), d)
check('抽取到图片', len(d.get('images', [])) > 0, len(d.get('images', [])))
check('文字提取正常', d.get('chars', 0) > 5000, d.get('chars'))
saved = call(admin, '/api/materials', {'name': '专项测试资料', 'text': d['text'], 'parseId': d['parseId']})
check('资料写入资料库', bool(saved.get('id')), saved)
check('图片随资料归档', saved.get('figure_count', 0) > 0, saved.get('figure_count'))
mid = saved.get('id', '')

r = call(admin, '/api/materials')
check('资料库列表包含该资料', any(m['id'] == mid for m in r), r if isinstance(r, dict) else len(r))
figs = call(admin, '/api/materials/' + mid + '/figures')
check('资料图片可列出', len(figs) > 0, len(figs))
mat = call(admin, '/api/materials/' + mid)
check('资料详情含全文', mat.get('chars', 0) > 5000, mat.get('chars'))
check('资料记录图片数', mat.get('figure_count', 0) > 0, mat.get('figure_count'))

# ---------- 2. 对话制题取材 ----------
print('\n[2] 对话制题引用资料库资料')
r = call(admin, '/api/chat/parse', {'materialId': mid, 'requirementText': '请出 4 道选择题，重点考查树与图的遍历，中等难度'})
check('可按 materialId 取材', r.get('materialInfo', {}).get('id') == mid, r.get('materialInfo'))
check('返回资料来源信息（含图数）', r.get('materialInfo', {}).get('figures', 0) > 0, r.get('materialInfo'))
check('报价含识图环节', any('识图' in l['role'] for l in r.get('est', {}).get('lines', [])), '')
check('需求解析出 4 题', sum(x['count'] for x in r.get('parsed', {}).get('requirements', [])) == 4, r.get('parsed', {}).get('requirements'))
r2 = call(admin, '/api/chat/parse', {'materialId': mid, 'requirementText': '短'})
check('只给资料不写需求会报错', r2.get('__http') == 400, r2)
r3 = call(admin, '/api/chat/parse', {'materialId': 'not_exist', 'requirementText': '请出 4 道选择题'})
check('不存在的资料返回 404', r3.get('__http') == 404, r3)

conf = call(admin, '/api/chat/confirm', {'parsed': r['parsed'], 'materialId': mid})
check('按资料库资料创建任务', bool(conf.get('taskId')), conf)
dt = wait_task(admin, conf.get('taskId'))
qt = dt.get('questions', [])
check('流水线跑完', len(qt) == 4, len(qt))
check('题目自动关联资料库原图', any(q.get('fig') for q in qt), [q.get('fig') for q in qt])
check('任务记录附图清单', len(dt['task'].get('figures', [])) > 0, len(dt['task'].get('figures', [])))

# ---------- 3. 精确制题取材 ----------
print('\n[3] 精确制题引用资料库资料')
r = call(admin, '/api/tasks', {'name': '精确制题-取材测试', 'requirements': [{'type': 'mcq', 'count': 3, 'kp': '线性表', 'ch': 2}], 'materialId': mid})
check('可按 materialId 建任务', bool(r.get('task', {}).get('id')), r)
check('初始状态为待批准', r.get('task', {}).get('status') == 'draft', r.get('task', {}).get('status'))
check('关联了资料库图片', len(r.get('figures', [])) > 0, len(r.get('figures', [])))
check('记录了取材来源', r.get('task', {}).get('source', {}).get('type') == 'library', r.get('task', {}).get('source'))
tid = r['task']['id']
call(admin, '/api/tasks/' + tid + '/approve', {})
call(admin, '/api/tasks/' + tid + '/run', {})
dt2 = wait_task(admin, tid)
check('精确制题流水线跑完', len(dt2.get('questions', [])) == 3, len(dt2.get('questions', [])))
check('题目关联原图', any(q.get('fig') for q in dt2.get('questions', [])), '')

ex = call(admin, '/api/tasks/' + tid + '/export', {})
check('导出成功', bool(ex.get('file')), ex)
if ex.get('content'):
    check('资料库原图内嵌为 base64', 'data:image' in ex['content'], '')
    check('内嵌张数 >= 1', ex.get('embedded', 0) >= 1, ex.get('embedded'))
    check('包格式可被刷题系统加载', 'registerSubject(' in ex['content'], '')

# ---------- 4. 上传解析直接制题（回归：不破坏原有路径） ----------
print('\n[4] 回归：直接上传解析制题（不经资料库）')
d2 = call(admin, '/api/parse?name=direct.pdf', raw=pdf)
r = call(admin, '/api/tasks', {'name': '直接上传制题', 'requirements': [{'type': 'mcq', 'count': 2, 'kp': '栈', 'ch': 3}],
                              'materialText': d2['text'], 'parseId': d2['parseId'],
                              'imageIds': [im['id'] for im in d2['images']], 'figureDescs': {}})
check('上传解析路径仍可用', bool(r.get('task', {}).get('id')), r)
check('图片来源标记为上传', r.get('task', {}).get('source', {}).get('type') == 'upload', r.get('task', {}).get('source'))
check('上传路径的图也被关联', len(r.get('figures', [])) > 0, len(r.get('figures', [])))
tid_direct = r['task']['id']
call(admin, '/api/tasks/' + tid_direct + '/approve', {})
call(admin, '/api/tasks/' + tid_direct + '/run', {})
dt3 = wait_task(admin, tid_direct)
check('上传路径流水线跑完', len(dt3.get('questions', [])) == 2, len(dt3.get('questions', [])))

# ---------- 5. 纯文本制题（无资料库、无上传） ----------
print('\n[5] 回归：纯文本粘贴制题')
r = call(admin, '/api/tasks', {'name': '纯文本制题', 'requirements': [{'type': 'mcq', 'count': 2, 'kp': '队列', 'ch': 3}],
                              'materialText': '队列是先进先出的线性表，循环队列用取模运算复用空间。' * 3})
check('纯文本路径仍可用', bool(r.get('task', {}).get('id')), r)
check('来源标记为粘贴', r.get('task', {}).get('source', {}).get('type') == 'paste', r.get('task', {}).get('source'))
check('纯文本任务无附图', len(r.get('figures', [])) == 0, len(r.get('figures', [])))

# ---------- 6. 数据隔离 ----------
print('\n[6] 资料库数据隔离')
other, _ = session()
call(other, '/api/auth/register', {'username': 'otherlib_' + str(int(time.time()))[-5:], 'password': 'other123456'})
r = call(other, '/api/materials/' + mid)
check('他人读不到我的资料（404）', r.get('__http') == 404, r)
r = call(other, '/api/materials/' + mid + '/figures')
check('他人读不到我的资料图片（404）', r.get('__http') == 404, r)
r = call(other, '/api/chat/confirm', {'parsed': {'name': 'x', 'requirements': [{'type': 'mcq', 'count': 1, 'diff': 1, 'ch': 1}]}, 'materialId': mid})
check('他人无法用我的资料建任务（404）', r.get('__http') == 404, r)
r = call(other, '/api/tasks', {'name': 'x', 'requirements': [{'type': 'mcq', 'count': 1, 'diff': 1, 'ch': 1}], 'materialId': mid})
check('他人无法在精确制题引用我的资料（404）', r.get('__http') == 404, r)
r = call(other, '/api/materials/' + mid, method='DELETE')
check('他人删不掉我的资料（404）', r.get('__http') == 404, r)

# ---------- 7. 删除 ----------
print('\n[7] 资料删除')
r = call(admin, '/api/materials/' + mid, method='DELETE')
check('本人可删除资料', r.get('ok') is True, r)
r = call(admin, '/api/materials/' + mid)
check('删除后不可读（404）', r.get('__http') == 404, r)

print('\n' + '=' * 60)
print('通过 %d 项，失败 %d 项' % (ok, fail))
print('=' * 60)
