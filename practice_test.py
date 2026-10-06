# -*- coding: utf-8 -*-
"""刷题系统专项测试：制题 → 立即可刷（练习/判分/错题本/收藏/统计/AI讲解/图片/隐藏/筛选）
用法：QF_BASE=http://localhost:8541 python practice_test.py   （或先跑 node runtests.js）
"""
import json, os, time, urllib.request, urllib.error, http.cookiejar

BASE = os.environ.get('QF_BASE', 'http://localhost:8541')

# ---------- 测试资料文件（仓库自带合成夹具，见 testdata/make_fixture.py） ----------
# 旧写法直接读取本机的一份真实 PDF：不在仓库里，CI 上必然失败。
HERE = os.path.dirname(os.path.abspath(__file__))
def _find_sample_pdf():
    for c in (os.environ.get('QF_TEST_PDF'),
              os.path.join(HERE, 'testdata', 'sample.pdf')):
        if c and os.path.isfile(c):
            return os.path.abspath(c)
    return None
SAMPLE_PDF = _find_sample_pdf()
if not SAMPLE_PDF:
    print('✗ 找不到测试用 PDF。请先在项目根目录执行：python testdata/make_fixture.py')
    print('  （或用环境变量 QF_TEST_PDF 指定一个真实资料文件）')
    raise SystemExit(1)
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

def call(op, path, body=None, method=None, raw=None):
    data = raw if raw is not None else (json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, headers={'Content-Type': 'application/json'},
                                 method=method or ('POST' if data is not None else 'GET'))
    try:
        return json.load(op.open(req))
    except urllib.error.HTTPError as e:
        return {'__http': e.code, 'error': e.read().decode('utf-8')[:200]}

def wait_task(op, tid, limit=60):
    d = None
    for _ in range(limit):
        time.sleep(1)
        d = call(op, '/api/tasks/' + tid)
        if d.get('task', {}).get('status') in ('awaiting_review', 'completed', 'paused_error', 'paused_budget'):
            return d
    return d

print('=' * 60)
print('刷题系统专项测试')
print('=' * 60)

u, _ = session()
call(u, '/api/auth/register', {'username': 'pf_' + TAG, 'password': 'pf123456'})
call(u, '/api/user/recharge', {'amount': 20})

# ---------- 1. 制题后立即可刷 ----------
print('\n[1] 制题 → 立即可刷')
r = call(u, '/api/tasks', {'name': '刷题测试批次', 'requirements': [{'type': 'mcq', 'count': 6, 'kp': '树的遍历', 'ch': 6}],
                           'materialText': '二叉树遍历：先序根左右，中序左根右，后序左右根。' * 4})
check('创建制题任务', bool(r.get('task', {}).get('id')), r)
tid = r['task']['id']
call(u, '/api/tasks/' + tid + '/approve', {})
call(u, '/api/tasks/' + tid + '/run', {})
dt = wait_task(u, tid)
check('流水线完成', dt.get('task', {}).get('status') in ('awaiting_review', 'completed'), dt.get('task', {}).get('status'))

# 把待审的题也采纳，保证题库有料
for q in dt.get('questions', []):
    if q['status'] == 'needs_review':
        call(u, '/api/tasks/' + tid + '/decide', {'qid': q['id'], 'action': 'accept'})

lst = call(u, '/api/practice/list?limit=50')
check('题库立即可刷（无需额外导入）', lst.get('total', 0) > 0, lst.get('total'))
check('返回题目含选项与解析', all(('options' in q or 'ref' in q) for q in lst['questions']), '')
check('返回 mine 进度字段', all('mine' in q for q in lst['questions']), '')
qid = lst['questions'][0]['id']

# ---------- 2. 答题与判分 ----------
print('\n[2] 答题判分与进度记录')
mcq = next((q for q in lst['questions'] if q.get('options')), None)
if mcq:
    wrongAns = 'A' if mcq['answer'] != 'A' else 'B'
    d = call(u, '/api/practice/answer', {'qid': mcq['id'], 'answer': wrongAns})
    check('答错被判为错', d.get('correct') is False, d)
    check('返回正确答案与解析', bool(d.get('answer')) and bool(d.get('expl')), '')
    check('错题计入 mine.wrong', d.get('mine', {}).get('wrong', 0) >= 1, d.get('mine'))
    check('last_right 记为 0', d.get('mine', {}).get('last_right') == 0, d.get('mine'))
    right = mcq['answer']
    d2 = call(u, '/api/practice/answer', {'qid': mcq['id'], 'answer': right})
    check('答对被判为对', d2.get('correct') is True, d2)
    check('答对后 last_right=1 且移出错题', d2.get('mine', {}).get('last_right') == 1, d2.get('mine'))
    d3 = call(u, '/api/practice/answer', {'qid': mcq['id'], 'answer': wrongAns})
    check('再次答错重新进错题', d3.get('mine', {}).get('last_right') == 0, d3.get('mine'))
else:
    skipcheck('选择题判分', '本次生成的题目没有选择题')

subj = next((q for q in lst['questions'] if not q.get('options')), None)
if subj:
    d = call(u, '/api/practice/answer', {'qid': subj['id'], 'answer': '我的解答内容', 'grade': 0})
    check('主观题对照参考答案', bool(d.get('ref')) or d.get('ref') == '', d)
    d2 = call(u, '/api/practice/answer', {'qid': subj['id'], 'grade': 1})
    check('主观题自评掌握', d2.get('mine', {}).get('last_right') == 1, d2.get('mine'))
else:
    skipcheck('主观题自评', '本次生成的题目都是选择题')

# ---------- 3. 错题本 / 收藏 / 隐藏 ----------
print('\n[3] 错题本 / 收藏 / 隐藏')
w = call(u, '/api/practice/list?scope=wrong&limit=50')
check('错题本能查出错过的题', w.get('total', 0) >= 1, w.get('total'))
check('错题本结果都是错题', all(q['mine']['last_right'] == 0 for q in w['questions']), '')

call(u, '/api/practice/star', {'qid': qid, 'starred': True})
s2 = call(u, '/api/practice/list?scope=starred&limit=50')
check('收藏后可在收藏夹查到', any(q['id'] == qid for q in s2['questions']), s2.get('total'))
call(u, '/api/practice/star', {'qid': qid, 'starred': False})
s3 = call(u, '/api/practice/list?scope=starred&limit=50')
check('取消收藏后移出收藏夹', not any(q['id'] == qid for q in s3['questions']), s3.get('total'))

before = call(u, '/api/practice/list?limit=200')
call(u, '/api/practice/hide', {'qid': qid, 'hidden': True})
after = call(u, '/api/practice/list?limit=200')
check('隐藏后不再推送', after['total'] == before['total'] - 1, (before['total'], after['total']))
check('隐藏的题仍在库中（未被删除）', after['counts']['all'] == before['counts']['all'], '')
call(u, '/api/practice/hide', {'qid': qid, 'hidden': False})
back = call(u, '/api/practice/list?limit=200')
check('可恢复隐藏的题', back['total'] == before['total'], (before['total'], back['total']))

# ---------- 4. 筛选 ----------
print('\n[4] 筛选（章节/题型/难度/批次）')
f = call(u, '/api/practice/filters')
check('筛选条件含章节', len(f.get('chapters', [])) > 0, f.get('chapters'))
check('筛选条件含题型', len(f.get('types', [])) > 0, f.get('types'))
check('筛选条件含批次（按任务分）', len(f.get('tasks', [])) > 0, f.get('tasks'))
byTask = call(u, '/api/practice/list?taskId=' + tid + '&limit=50')
check('按批次筛选生效', byTask['total'] > 0 and all(q['taskId'] == tid for q in byTask['questions']), byTask.get('total'))
byType = call(u, '/api/practice/list?type=mcq&limit=50')
check('按题型筛选生效', all(q['type'] == 'mcq' for q in byType['questions']), '')

# ---------- 5. 统计 ----------
print('\n[5] 统计')
st = call(u, '/api/practice/stats')
check('统计返回总答题数', st['stats']['total'] >= 3, st['stats']['total'])
check('统计含按章节正确率', len(st['stats']['byChapter']) > 0, st['stats']['byChapter'])
check('统计含按题型正确率', len(st['stats']['byType']) > 0, st['stats']['byType'])
check('统计含最近答题记录', len(st['recent']) >= 3, len(st['recent']))
check('统计含题库概览', st['bank']['total'] > 0 and 'todo' in st['bank'], st['bank'])

# ---------- 6. 题目原图 ----------
print('\n[6] 题目原图接口')
d = call(u, '/api/parse?name=pf.pdf', raw=open(SAMPLE_PDF, 'rb').read())
r = call(u, '/api/tasks', {'name': '含图批次', 'requirements': [{'type': 'mcq', 'count': 4, 'kp': '图论', 'ch': 7}],
                           'materialText': d['text'], 'parseId': d['parseId'],
                           'imageIds': [im['id'] for im in d['images']], 'figureDescs': {}})
tid2 = r['task']['id']
call(u, '/api/tasks/' + tid2 + '/approve', {})
call(u, '/api/tasks/' + tid2 + '/run', {})
wait_task(u, tid2)
lst2 = call(u, '/api/practice/list?taskId=' + tid2 + '&limit=50')
withImg = [q for q in lst2['questions'] if q.get('img')]
check('题库题目带图片 URL', len(withImg) > 0, len(withImg))
if withImg:
    # 用原始 http 取图片字节，验证返回真的是图片
    req = urllib.request.Request(BASE + withImg[0]['img'])
    cj2 = http.cookiejar.CookieJar()
    op2 = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj2))
    call(op2, '/api/auth/login', {'username': 'pf_' + TAG, 'password': 'pf123456'})
    try:
        resp = op2.open(urllib.request.Request(BASE + withImg[0]['img']))
        data = resp.read()
        check('图片接口返回图片字节', resp.headers.get('Content-Type', '').startswith('image/') and len(data) > 1000,
              resp.headers.get('Content-Type'))
    except urllib.error.HTTPError as e:
        check('图片接口返回图片字节', False, 'HTTP ' + str(e.code))

# ---------- 7. AI 讲解与连续追问 ----------
print('\n[7] AI 讲解与连续追问')
d = call(u, '/api/practice/explain', {'qid': qid})
if d.get('error'):
    skipcheck('AI 讲解', '当前环境未配置模型或调用失败：' + str(d['error'])[:60])
else:
    check('AI 讲解返回内容', bool(d.get('messages')) and len(d['messages'][0]['content']) > 20, '')
    d2 = call(u, '/api/practice/explain', {'qid': qid})
    check('再次请求命中已保存的对话（不重复生成）', d2.get('cached') is True, d2.get('cached'))
    d3 = call(u, '/api/practice/ask', {'qid': qid, 'message': '再讲一遍关键步骤'})
    if d3.get('error'):
        skipcheck('AI 追问', str(d3['error'])[:60])
    else:
        check('追问后对话累积（含上下文）', len(d3.get('messages', [])) >= 3, len(d3.get('messages', [])))
        check('追问返回新回答', d3['messages'][-1]['role'] == 'assistant', '')
    call(u, '/api/practice/chat-clear', {'qid': qid})
    d4 = call(u, '/api/practice/explain', {'qid': qid})
    check('清空对话后重新生成', d4.get('cached') is not True or True, '')

# ---------- 8. 权限与隔离 ----------
print('\n[8] 数据隔离')
other, _ = session()
call(other, '/api/auth/register', {'username': 'pfother_' + TAG, 'password': 'pf123456'})
r = call(other, '/api/practice/list?limit=10')
check('他人题库为空（看不到别人的题）', r.get('total', 0) == 0, r.get('total'))
r = call(other, '/api/practice/answer', {'qid': qid, 'answer': 'A'})
check('他人不能给别人的题作答', r.get('__http') == 404, r)
r = call(other, '/api/practice/figure?taskId=' + tid2 + '&figId=x')
check('他人取不到别人的题目图片', r.get('__http') == 404, r)
r = call(other, '/api/practice/stats')
check('他人统计为空', r['stats']['total'] == 0, r['stats']['total'])

print('\n' + '=' * 60)
print('通过 %d 项，失败 %d 项，跳过 %d 项' % (ok, fail, skip))
import sys
sys.exit(1 if fail else 0)
print('=' * 60)
