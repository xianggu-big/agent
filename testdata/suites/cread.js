/* 第二套题集：C 程序阅读题（给代码 + 问输出）—— 阶段二用，验证"第二类题型 × 第二种判分"
 *
 * 为什么单独一套：calgo 那套是"写代码解题"、判分靠跑代码比对（exec）；
 * 这一套是"读程序、模拟执行、给出精确输出"——**这本来就是题库里的真实题型**（阅读算法题），
 * 而且它的判分方式完全不同（structured：要求返回 {"output":"..."} 逐字段比对）。
 * 两类题型都能跑出指标，才能说明框架不是为某一个实验写的。
 *
 * ★ 标准答案的来历：每题都真编译真运行、把实际输出冻结在这里（不靠手算）。
 *   evalsuite_test.js 每次全量测试都会重新编译运行一遍逐题核对——题集里的答案被改错会立刻变红。
 *
 * ⚠ 题目与代码均为本项目自拟的合成内容，不含任何真实试题。
 * ⚠ 这些程序只为"阅读"而写（含刻意保留的写法陷阱），不是良好风格示范。
 */
'use strict';

const PROMPT_HEAD = [
  '你是 C 语言与数据结构助教。下面是一段完整、可编译、可运行的 C 程序。',
  '请**逐行模拟执行**它，给出它运行时打印到标准输出的**完整内容**（空格、换行、标点都要与真实运行一致）。',
  '',
  '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码围栏，格式为：',
  '{"output":"程序的标准输出，换行写成 \\n"}',
  '',
  '════════ 程序 ════════',
  ''
].join('\n');

module.exports = {
  id: 'cread',
  title: 'C 程序阅读题（给代码问输出）',
  judge: 'structured',                            // 逐字段比对（不是跑代码）
  fields: { output: 'output' },
  prompt(item) {
    return PROMPT_HEAD + '```c\n' + item.src + '\n```';
  },
  items: [
  {
    id: 'r01',
    group: '数据结构',
    title: "循环队列（牺牲一个单元判满）",
    expect: { output: "0 5 3\n15 0" },
    src: `#include <stdio.h>
#define N 6
int q[N], front = 0, rear = 0, rej = 0;
void enq(int x){ if ((rear + 1) % N == front) { rej++; return; } q[rear] = x; rear = (rear + 1) % N; }
int deq(void){ if (rear == front) return -1; int v = q[front]; front = (front + 1) % N; return v; }
int main(void){
  int a[8] = {1, 2, 3, 4, 5, 6, 7, 8};
  for (int i = 0; i < 8; i++) enq(a[i]);
  printf("%d %d %d\\n", front, rear, rej);
  int s = 0;
  for (int i = 0; i < 5; i++) s += deq();
  printf("%d %d\\n", s, q[front % N]);
  return 0;
}`
  },
  {
    id: 'r02',
    group: '数据结构',
    title: "二分查找（比较次数与查找失败后的 lo）",
    expect: { output: "7:1,3,0\n8:3,-1,4\n1:3,0,0\n14:3,-1,7" },
    src: `#include <stdio.h>
int main(void){
  int a[7] = {1, 3, 5, 7, 9, 11, 13};
  int keys[4] = {7, 8, 1, 14};
  for (int k = 0; k < 4; k++){
    int lo = 0, hi = 6, cnt = 0, idx = -1;
    while (lo <= hi){
      int mid = (lo + hi) / 2;
      cnt++;
      if (a[mid] == keys[k]) { idx = mid; break; }
      if (a[mid] < keys[k]) lo = mid + 1; else hi = mid - 1;
    }
    printf("%d:%d,%d,%d\\n", keys[k], cnt, idx, lo);
  }
  return 0;
}`
  },
  {
    id: 'r03',
    group: '语言陷阱',
    title: "switch 穿透（case 0 落进 case 1）",
    expect: { output: "13" },
    src: `#include <stdio.h>
int main(void){
  int x = 0;
  for (int i = 1; i <= 5; i++){
    switch (i % 3){
      case 0: x += i;
      case 1: x += 2;
              break;
      case 2: x += 3;
      default: x -= 1;
    }
  }
  printf("%d\\n", x);
  return 0;
}`
  },
  {
    id: 'r04',
    group: '语言陷阱',
    title: "递归 + static 局部变量（调用次序与计数）",
    expect: { output: "leaf1:4\nleaf0:5\nleaf1:6\nleaf1:8\nleaf0:9\n3" },
    src: `#include <stdio.h>
int f(int n){
  static int calls = 0;
  calls++;
  if (n <= 1) { printf("leaf%d:%d\\n", n, calls); return n; }
  return f(n - 1) + f(n - 2);
}
int main(void){
  printf("%d\\n", f(4));
  return 0;
}`
  },
  {
    id: 'r05',
    group: '语言陷阱',
    title: "带参宏没加括号（SQ(x) x*x）",
    expect: { output: "11 12\n102" },
    src: `#include <stdio.h>
#define SQ(x) x*x
int main(void){
  int i = 3, j = 2;
  printf("%d %d\\n", SQ(i + j), SQ(i + j) + 1);
  printf("%d\\n", 100 / SQ(1 + 1));
  return 0;
}`
  },
  {
    id: 'r06',
    group: '语言陷阱',
    title: "printf 的返回值（打印字符数）嵌套",
    expect: { output: "abc|3|\n3" },
    src: `#include <stdio.h>
int main(void){
  int n = printf("abc");
  int m = printf("|%d|", n);
  printf("\\n%d\\n", m);
  return 0;
}`
  },
  {
    id: 'r07',
    group: '数据结构',
    title: "约瑟夫环出列顺序（n=7, m=3）",
    expect: { output: "3 6 2 7 5 1 4" },
    src: `#include <stdio.h>
int main(void){
  int n = 7, m = 3, a[7], out[7], k = 0, idx = 0, alive = n;
  for (int i = 0; i < n; i++) a[i] = 1;
  while (alive){
    int c = 0;
    while (c < m){
      if (a[idx]) c++;
      if (c == m) break;
      idx = (idx + 1) % n;
    }
    a[idx] = 0; out[k++] = idx + 1; alive--; idx = (idx + 1) % n;
  }
  for (int i = 0; i < n; i++) printf("%d ", out[i]);
  printf("\\n");
  return 0;
}`
  },
  {
    id: 'r08',
    group: '数据结构',
    title: "后缀表达式求值（整数除法截断）",
    expect: { output: "2" },
    src: `#include <stdio.h>
int main(void){
  const char *e = "34+2*71-/";
  int st[16], top = -1;
  for (int i = 0; e[i]; i++){
    char c = e[i];
    if (c >= '0' && c <= '9') { st[++top] = c - '0'; continue; }
    int b = st[top--], a = st[top--];
    switch (c){
      case '+': st[++top] = a + b; break;
      case '-': st[++top] = a - b; break;
      case '*': st[++top] = a * b; break;
      default:  st[++top] = a / b; break;
    }
  }
  printf("%d\\n", st[top]);
  return 0;
}`
  },
  {
    id: 'r09',
    group: '数据结构',
    title: "先序+中序序列重建二叉树，输出后序",
    expect: { output: "DEBFGCA" },
    src: `#include <stdio.h>
#include <string.h>
char post[64];
int k = 0;
void build(const char *pre, const char *in, int n){
  if (n <= 0) return;
  char root = pre[0];
  int i = 0;
  while (i < n && in[i] != root) i++;
  build(pre + 1, in, i);
  build(pre + 1 + i, in + i + 1, n - i - 1);
  post[k++] = root;
}
int main(void){
  const char *pre = "ABDECFG", *in = "DBEAFCG";
  build(pre, in, (int)strlen(pre));
  post[k] = 0;
  printf("%s\\n", post);
  return 0;
}`
  },
  {
    id: 'r10',
    group: '数据结构',
    title: "自底向上建最大堆后的数组",
    expect: { output: "9 7 8 6 1 3 2 4" },
    src: `#include <stdio.h>
void sift(int a[], int n, int i){
  while (1){
    int l = 2 * i + 1, r = 2 * i + 2, m = i;
    if (l < n && a[l] > a[m]) m = l;
    if (r < n && a[r] > a[m]) m = r;
    if (m == i) return;
    int t = a[i]; a[i] = a[m]; a[m] = t;
    i = m;
  }
}
int main(void){
  int a[8] = {4, 9, 3, 7, 1, 8, 2, 6};
  int n = 8;
  for (int i = n / 2 - 1; i >= 0; i--) sift(a, n, i);
  for (int i = 0; i < n; i++) printf("%d ", a[i]);
  printf("\\n");
  return 0;
}`
  },
  {
    id: 'r11',
    group: '数据结构',
    title: "快速排序一趟划分（挖坑法，取首元素为枢轴）",
    expect: { output: "4: 4 3 2 1 5 9 7 8" },
    src: `#include <stdio.h>
int partition(int a[], int lo, int hi){
  int p = a[lo];
  while (lo < hi){
    while (lo < hi && a[hi] >= p) hi--;
    a[lo] = a[hi];
    while (lo < hi && a[lo] <= p) lo++;
    a[hi] = a[lo];
  }
  a[lo] = p;
  return lo;
}
int main(void){
  int a[8] = {5, 3, 8, 1, 9, 2, 7, 4};
  int pos = partition(a, 0, 7);
  printf("%d:", pos);
  for (int i = 0; i < 8; i++) printf(" %d", a[i]);
  printf("\\n");
  return 0;
}`
  },
  {
    id: 'r12',
    group: '数据结构',
    title: "哈希表线性探查（最终表 + 探查次数）",
    expect: { output: "22 1 46 13 -1 -1 -1 -1 41 53 30\n3" },
    src: `#include <stdio.h>
int main(void){
  int H[11], n = 11, probes = 0;
  for (int i = 0; i < n; i++) H[i] = -1;
  int keys[7] = {22, 41, 53, 46, 30, 13, 1};
  for (int k = 0; k < 7; k++){
    int i = keys[k] % n;
    while (H[i] != -1){ probes++; i = (i + 1) % n; }
    H[i] = keys[k];
  }
  for (int i = 0; i < n; i++) printf("%d ", H[i]);
  printf("\\n%d\\n", probes);
  return 0;
}`
  },
  {
    id: 'r13',
    group: '数据结构',
    title: "Dijkstra 求单源最短路的 dist 数组",
    expect: { output: "0 7 9 20 20 11" },
    src: `#include <stdio.h>
#define INF 99999
#define V 6
int main(void){
  int g[V][V], d[V], done[V];
  for (int i = 0; i < V; i++){
    d[i] = INF; done[i] = 0;
    for (int j = 0; j < V; j++) g[i][j] = (i == j) ? 0 : INF;
  }
  int es[9][3] = {{0,1,7},{0,2,9},{0,5,14},{1,2,10},{1,3,15},{2,3,11},{2,5,2},{3,4,6},{4,5,9}};
  for (int e = 0; e < 9; e++){ g[es[e][0]][es[e][1]] = es[e][2]; g[es[e][1]][es[e][0]] = es[e][2]; }
  d[0] = 0;
  for (int it = 0; it < V; it++){
    int u = -1, best = INF;
    for (int i = 0; i < V; i++) if (!done[i] && d[i] < best) { best = d[i]; u = i; }
    if (u < 0) break;
    done[u] = 1;
    for (int v = 0; v < V; v++)
      if (!done[v] && g[u][v] < INF && d[u] + g[u][v] < d[v]) d[v] = d[u] + g[u][v];
  }
  for (int i = 0; i < V; i++) printf("%d ", d[i]);
  printf("\\n");
  return 0;
}`
  },
  {
    id: 'r14',
    group: '数据结构',
    title: "哈夫曼树的带权路径长度 WPL",
    expect: { output: "208" },
    src: `#include <stdio.h>
int main(void){
  int w[6] = {5, 8, 12, 15, 20, 25};
  int n = 6, total = 0;
  while (n > 1){
    int a = -1, b = -1;
    for (int i = 0; i < n; i++) if (a < 0 || w[i] < w[a]) a = i;
    for (int i = 0; i < n; i++) if (i != a && (b < 0 || w[i] < w[b])) b = i;
    int s = w[a] + w[b];
    total += s;
    w[a] = s; w[b] = w[n - 1]; n--;
  }
  printf("%d\\n", total);
  return 0;
}`
  },
  {
    id: 'r15',
    group: '数据结构',
    title: "KMP 的 next 数组（next[0] = -1 约定）",
    expect: { output: "-1 0 0 1 2 3" },
    src: `#include <stdio.h>
#include <string.h>
void getnext(const char *p, int next[]){
  int i = 0, j = -1, n = (int)strlen(p);
  next[0] = -1;
  while (i < n - 1){
    if (j == -1 || p[i] == p[j]) { i++; j++; next[i] = j; }
    else j = next[j];
  }
}
int main(void){
  const char *p = "ababaa";
  int next[8];
  getnext(p, next);
  for (int i = 0; i < (int)strlen(p); i++) printf("%d ", next[i]);
  printf("\\n");
  return 0;
}`
  },
  {
    id: 'r16',
    group: '数据结构',
    title: "朴素串匹配（匹配位置 + 字符比较次数）",
    expect: { output: "3 14" },
    src: `#include <stdio.h>
#include <string.h>
int main(void){
  const char *s = "abcabcabd", *p = "abcabd";
  int n = (int)strlen(s), m = (int)strlen(p), cmp = 0, pos = -1;
  for (int i = 0; i + m <= n; i++){
    int j = 0;
    while (j < m){ cmp++; if (s[i + j] != p[j]) break; j++; }
    if (j == m) { pos = i; break; }
  }
  printf("%d %d\\n", pos, cmp);
  return 0;
}`
  },
  {
    id: 'r17',
    group: '数据结构',
    title: "归并排序每一趟结束后的数组",
    expect: { output: "38 49 65 97 13 76 27 49\n38 49 65 97 13 27 49 76\n13 27 38 49 49 65 76 97" },
    src: `#include <stdio.h>
void merge(int a[], int t[], int lo, int mid, int hi){
  int i = lo, j = mid + 1, k = lo;
  while (i <= mid && j <= hi) t[k++] = (a[i] <= a[j]) ? a[i++] : a[j++];
  while (i <= mid) t[k++] = a[i++];
  while (j <= hi) t[k++] = a[j++];
  for (int x = lo; x <= hi; x++) a[x] = t[x];
}
int main(void){
  int a[8] = {49, 38, 65, 97, 76, 13, 27, 49};
  int t[8], n = 8;
  for (int w = 1; w < n; w *= 2){
    for (int lo = 0; lo < n; lo += 2 * w){
      int mid = lo + w - 1, hi = lo + 2 * w - 1;
      if (mid >= n) mid = n - 1;
      if (hi >= n) hi = n - 1;
      if (mid < hi) merge(a, t, lo, mid, hi);
    }
    for (int i = 0; i < n; i++) printf("%d ", a[i]);
    printf("\\n");
  }
  return 0;
}`
  },
  {
    id: 'r18',
    group: '数据结构',
    title: "括号匹配（是否合法 + 最大嵌套深度）",
    expect: { output: "1 3" },
    src: `#include <stdio.h>
int main(void){
  const char *s = "{[a(b)c]d}(e)";
  int st[32], top = -1, ok = 1, maxd = 0;
  for (int i = 0; s[i]; i++){
    char c = s[i];
    if (c == '(' || c == '[' || c == '{') { st[++top] = c; if (top + 1 > maxd) maxd = top + 1; }
    else if (c == ')' || c == ']' || c == '}'){
      char m = (c == ')') ? '(' : (c == ']' ? '[' : '{');
      if (top < 0 || st[top--] != m) { ok = 0; break; }
    }
  }
  if (top >= 0) ok = 0;
  printf("%d %d\\n", ok, maxd);
  return 0;
}`
  },
  {
    id: 'r19',
    group: '数据结构',
    title: "顺序表删除指定元素（删除后长度 + 移动元素的个数）",
    expect: { output: "6 6: 7 9 5 8 1 4" },
    src: `#include <stdio.h>
int main(void){
  int a[10] = {3, 7, 3, 9, 3, 5, 8, 3, 1, 4};
  int n = 10, x = 3, moves = 0, k = 0;
  for (int i = 0; i < n; i++){
    if (a[i] == x) k++;
    else { a[i - k] = a[i]; if (k) moves++; }
  }
  n -= k;
  printf("%d %d:", n, moves);
  for (int i = 0; i < n; i++) printf(" %d", a[i]);
  printf("\\n");
  return 0;
}`
  },
  {
    id: 'r20',
    group: '数据结构',
    title: "二叉树叶子数与高度（链式存储递归）",
    expect: { output: "5 4" },
    src: `#include <stdio.h>
typedef struct T { int v; struct T *l, *r; } T;
int leaves(T *t){ if (!t) return 0; if (!t->l && !t->r) return 1; return leaves(t->l) + leaves(t->r); }
int height(T *t){ if (!t) return 0; int a = height(t->l), b = height(t->r); return 1 + (a > b ? a : b); }
int main(void){
  T a = {1, 0, 0}, b = {2, 0, 0}, c = {3, 0, 0}, d = {4, 0, 0}, e = {5, 0, 0};
  T f = {6, &a, &b}, g = {7, &c, &d}, h = {8, &e, &f}, i = {9, &g, 0}, j = {10, &i, &h};
  printf("%d %d\\n", leaves(&j), height(&j));
  return 0;
}`
  }
  ]
};
