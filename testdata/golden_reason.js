/* 推理题金标题（D1 对照实验用）：14 道"读程序判断输出"题
 *
 * 为什么是这套题：这是**心算最不靠谱**的一类题（实测准确率约 31%，docs/EVALSUITE.md 阶段二），
 * 而有了 run_code（在断网沙箱里真跑代码）之后，模型完全可以把程序跑一遍再答 —— 两者应当拉开差距。
 * 它同时是"给代码问输出"这种真实题型在质检环节的样子。
 *
 * ★ 正确答案的来历：题面来自 testdata/suites/cread.js，那些程序的输出是**真编译真运行**冻结的，
 *   这份文件只是把它们改写成选择题形式（选项顺序按 id 哈希确定性打乱）。
 * ★ 干扰项的来历：**模型在真实跑里答错的原话** + 两个合理变体 —— 用真实错误当干扰项，题目才不失真。
 * ⚠ 题目与代码均为本项目自拟的合成内容，不含任何真实试题。
 */
/* 注意：**不要写 module.exports** —— loadGolden 用 new Function 加载（同 golden_calc.js）。 */
'use strict';
const QUESTIONS = [
  {
    "id": "d1_r01",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "A",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\n#define N 6\nint q[N], front = 0, rear = 0, rej = 0;\nvoid enq(int x){ if ((rear + 1) % N == front) { rej++; return; } q[rear] = x; rear = (rear + 1) % N; }\nint deq(void){ if (rear == front) return -1; int v = q[front]; front = (front + 1) % N; return v; }\nint main(void){\n  int a[8] = {1, 2, 3, 4, 5, 6, 7, 8};\n  for (int i = 0; i < 8; i++) enq(a[i]);\n  printf(\"%d %d %d\\n\", front, rear, rej);\n  int s = 0;\n  for (int i = 0; i < 5; i++) s += deq();\n  printf(\"%d %d\\n\", s, q[front % N]);\n  return 0;\n}\n```",
    "options": [
      "0 5 3\n15 0",
      "0 5 2\n15 1",
      "0 5 2\n15 6",
      "0 5 3\n15 1"
    ]
  },
  {
    "id": "d1_r02",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "B",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\nint main(void){\n  int a[7] = {1, 3, 5, 7, 9, 11, 13};\n  int keys[4] = {7, 8, 1, 14};\n  for (int k = 0; k < 4; k++){\n    int lo = 0, hi = 6, cnt = 0, idx = -1;\n    while (lo <= hi){\n      int mid = (lo + hi) / 2;\n      cnt++;\n      if (a[mid] == keys[k]) { idx = mid; break; }\n      if (a[mid] < keys[k]) lo = mid + 1; else hi = mid - 1;\n    }\n    printf(\"%d:%d,%d,%d\\n\", keys[k], cnt, idx, lo);\n  }\n  return 0;\n}\n```",
    "options": [
      "7:1,3,0\n8:3,-1,3\n1:3,0,0\n14:3,-1,7",
      "7:1,3,0\n8:3,-1,4\n1:3,0,0\n14:3,-1,7",
      "7:1,3,3\n8:3,-1,4\n1:3,0,0\n14:3,-1,7",
      "7:1,3,3\n8:2,-1,4\n1:3,0,0\n14:3,-1,7"
    ]
  },
  {
    "id": "d1_r03",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "C",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\nint main(void){\n  int x = 0;\n  for (int i = 1; i <= 5; i++){\n    switch (i % 3){\n      case 0: x += i;\n      case 1: x += 2;\n              break;\n      case 2: x += 3;\n      default: x -= 1;\n    }\n  }\n  printf(\"%d\\n\", x);\n  return 0;\n}\n```",
    "options": [
      "17",
      "15",
      "13",
      "11"
    ]
  },
  {
    "id": "d1_r04",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "D",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\nint f(int n){\n  static int calls = 0;\n  calls++;\n  if (n <= 1) { printf(\"leaf%d:%d\\n\", n, calls); return n; }\n  return f(n - 1) + f(n - 2);\n}\nint main(void){\n  printf(\"%d\\n\", f(4));\n  return 0;\n}\n```",
    "options": [
      "leaf1:3\nleaf0:4\nleaf1:5\nleaf1:6\nleaf0:7\n3",
      "leaf1:1\nleaf0:2\nleaf1:3\nleaf1:4\nleaf0:5\n3",
      "leaf1:4\nleaf0:5\nleaf1:6\nleaf1:7\nleaf0:8\n2",
      "leaf1:4\nleaf0:5\nleaf1:6\nleaf1:8\nleaf0:9\n3"
    ]
  },
  {
    "id": "d1_r05",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "A",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\n#define SQ(x) x*x\nint main(void){\n  int i = 3, j = 2;\n  printf(\"%d %d\\n\", SQ(i + j), SQ(i + j) + 1);\n  printf(\"%d\\n\", 100 / SQ(1 + 1));\n  return 0;\n}\n```",
    "options": [
      "11 12\n102",
      "25 12\n102",
      "11 12\n100",
      "11 12\n33"
    ]
  },
  {
    "id": "d1_r06",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "B",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\nint main(void){\n  int n = printf(\"abc\");\n  int m = printf(\"|%d|\", n);\n  printf(\"\\n%d\\n\", m);\n  return 0;\n}\n```",
    "options": [
      "abc|3|\n4",
      "abc|3|\n3",
      "abc|3|\n2",
      "abc|3|\n5"
    ]
  },
  {
    "id": "d1_r08",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "C",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\nint main(void){\n  const char *e = \"34+2*71-/\";\n  int st[16], top = -1;\n  for (int i = 0; e[i]; i++){\n    char c = e[i];\n    if (c >= '0' && c <= '9') { st[++top] = c - '0'; continue; }\n    int b = st[top--], a = st[top--];\n    switch (c){\n      case '+': st[++top] = a + b; break;\n      case '-': st[++top] = a - b; break;\n      case '*': st[++top] = a * b; break;\n      default:  st[++top] = a / b; break;\n    }\n  }\n  printf(\"%d\\n\", st[top]);\n  return 0;\n}\n```",
    "options": [
      "1",
      "-1",
      "2",
      "3"
    ]
  },
  {
    "id": "d1_r10",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "D",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\nvoid sift(int a[], int n, int i){\n  while (1){\n    int l = 2 * i + 1, r = 2 * i + 2, m = i;\n    if (l < n && a[l] > a[m]) m = l;\n    if (r < n && a[r] > a[m]) m = r;\n    if (m == i) return;\n    int t = a[i]; a[i] = a[m]; a[m] = t;\n    i = m;\n  }\n}\nint main(void){\n  int a[8] = {4, 9, 3, 7, 1, 8, 2, 6};\n  int n = 8;\n  for (int i = n / 2 - 1; i >= 0; i--) sift(a, n, i);\n  for (int i = 0; i < n; i++) printf(\"%d \", a[i]);\n  printf(\"\\n\");\n  return 0;\n}\n```",
    "options": [
      "9 8 7 6 1 3 2 4",
      "9 7 8 6 1 4 3 2",
      "9 7 8 6 1 4 2 3",
      "9 7 8 6 1 3 2 4"
    ]
  },
  {
    "id": "d1_r12",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "A",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\nint main(void){\n  int H[11], n = 11, probes = 0;\n  for (int i = 0; i < n; i++) H[i] = -1;\n  int keys[7] = {22, 41, 53, 46, 30, 13, 1};\n  for (int k = 0; k < 7; k++){\n    int i = keys[k] % n;\n    while (H[i] != -1){ probes++; i = (i + 1) % n; }\n    H[i] = keys[k];\n  }\n  for (int i = 0; i < n; i++) printf(\"%d \", H[i]);\n  printf(\"\\n%d\\n\", probes);\n  return 0;\n}\n```",
    "options": [
      "22 1 46 13 -1 -1 -1 -1 41 53 30\n3",
      "22 1 46 13 30 41 53 -1 -1 -1 -1\n3",
      "22 1 13 -1 -1 -1 46 30 41 53 -1\n3",
      "22 1 46 13 -1 -1 -1 -1 41 53 30\n4"
    ]
  },
  {
    "id": "d1_r14",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "B",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\nint main(void){\n  int w[6] = {5, 8, 12, 15, 20, 25};\n  int n = 6, total = 0;\n  while (n > 1){\n    int a = -1, b = -1;\n    for (int i = 0; i < n; i++) if (a < 0 || w[i] < w[a]) a = i;\n    for (int i = 0; i < n; i++) if (i != a && (b < 0 || w[i] < w[b])) b = i;\n    int s = w[a] + w[b];\n    total += s;\n    w[a] = s; w[b] = w[n - 1]; n--;\n  }\n  printf(\"%d\\n\", total);\n  return 0;\n}\n```",
    "options": [
      "233",
      "208",
      "163",
      "189"
    ]
  },
  {
    "id": "d1_r16",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "C",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\n#include <string.h>\nint main(void){\n  const char *s = \"abcabcabd\", *p = \"abcabd\";\n  int n = (int)strlen(s), m = (int)strlen(p), cmp = 0, pos = -1;\n  for (int i = 0; i + m <= n; i++){\n    int j = 0;\n    while (j < m){ cmp++; if (s[i + j] != p[j]) break; j++; }\n    if (j == m) { pos = i; break; }\n  }\n  printf(\"%d %d\\n\", pos, cmp);\n  return 0;\n}\n```",
    "options": [
      "-1 14",
      "3 12",
      "3 14",
      "3 15"
    ]
  },
  {
    "id": "d1_r18",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "D",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\nint main(void){\n  const char *s = \"{[a(b)c]d}(e)\";\n  int st[32], top = -1, ok = 1, maxd = 0;\n  for (int i = 0; s[i]; i++){\n    char c = s[i];\n    if (c == '(' || c == '[' || c == '{') { st[++top] = c; if (top + 1 > maxd) maxd = top + 1; }\n    else if (c == ')' || c == ']' || c == '}'){\n      char m = (c == ')') ? '(' : (c == ']' ? '[' : '{');\n      if (top < 0 || st[top--] != m) { ok = 0; break; }\n    }\n  }\n  if (top >= 0) ok = 0;\n  printf(\"%d %d\\n\", ok, maxd);\n  return 0;\n}\n```",
    "options": [
      "1 4",
      "0 3",
      "1 2",
      "1 3"
    ]
  },
  {
    "id": "d1_r19",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "A",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\nint main(void){\n  int a[10] = {3, 7, 3, 9, 3, 5, 8, 3, 1, 4};\n  int n = 10, x = 3, moves = 0, k = 0;\n  for (int i = 0; i < n; i++){\n    if (a[i] == x) k++;\n    else { a[i - k] = a[i]; if (k) moves++; }\n  }\n  n -= k;\n  printf(\"%d %d:\", n, moves);\n  for (int i = 0; i < n; i++) printf(\" %d\", a[i]);\n  printf(\"\\n\");\n  return 0;\n}\n```",
    "options": [
      "6 6: 7 9 5 8 1 4",
      "6 6: 7 9 5 8 1 3",
      "7 4: 7 9 5 8 1 4",
      "6 5: 7 9 5 8 1 4"
    ]
  },
  {
    "id": "d1_r20",
    "type": "mcq",
    "ch": 9,
    "kp": "推理题金标（D1）",
    "verified": true,
    "answer": "B",
    "stem": "下面这段 C 程序（只使用标准库，无输入）在标准输出上打印什么？请判断它的实际输出是什么。\n```c\n#include <stdio.h>\ntypedef struct T { int v; struct T *l, *r; } T;\nint leaves(T *t){ if (!t) return 0; if (!t->l && !t->r) return 1; return leaves(t->l) + leaves(t->r); }\nint height(T *t){ if (!t) return 0; int a = height(t->l), b = height(t->r); return 1 + (a > b ? a : b); }\nint main(void){\n  T a = {1, 0, 0}, b = {2, 0, 0}, c = {3, 0, 0}, d = {4, 0, 0}, e = {5, 0, 0};\n  T f = {6, &a, &b}, g = {7, &c, &d}, h = {8, &e, &f}, i = {9, &g, 0}, j = {10, &i, &h};\n  printf(\"%d %d\\n\", leaves(&j), height(&j));\n  return 0;\n}\n```",
    "options": [
      "4 4",
      "5 4",
      "4 5",
      "5 3"
    ]
  }
];
