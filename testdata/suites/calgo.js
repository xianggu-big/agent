/* 第一套题集：C 算法题（20 基础 + 6 陷阱题）—— 搬运自与项目平级的 llm_test 实验
 *
 * 为什么搬进来：llm_test 是一次性脚本，结论（"模型的代码 100% 正确，但它嘴上报的
 * 隐藏用例答案有 16.7% 与自己的代码输出矛盾"）留在那儿没法复现、没法比较新模型。
 * 搬成题集后，任何岗位绑的模型都能在同一套题上跑出可比数字。
 *
 * 判分方式 judge='exec'：**编译并运行模型写的代码**，拿隐藏用例的实际输出当判分依据，
 * 不是让另一个模型打分。隐藏用例的 expected 是参考实现（refs/*.c）本地跑出来的，
 * 由 evalsuite_test.js 在每次全量测试时重新跑一遍参考实现核对（防止这里的值被写错）。
 *
 * ⚠ 这些 expected 与题目文本均为本项目自拟/合成内容，不含任何真实试题。
 * ⚠ 运行模型生成的代码有安全风险：本地实验用途，带超时；生产必须进容器沙箱。
 */
'use strict';

/* 给模型的题面：要求它同时交"代码"和"它认为的输出"。
 * 两个都要，是因为要算**自相矛盾率**（它说的 vs 它写的代码真跑出来的）。 */
function buildPrompt(item) {
  const hiddenList = item.hidden.map((h, i) => '第 ' + (i + 1) + ' 条：\n' + h.in.trimEnd()).join('\n\n');
  return [
    '你是一名 C 语言助教，请完成下面这道算法题。',
    '',
    '要求：',
    '1) 写一个完整、可独立编译运行的 C 程序（从标准输入读数据、向标准输出打印结果），只用标准库；',
    '2) 对下面"待预测输入"的每一条，给出你认为该程序会输出的结果。',
    '',
    '严格只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏，格式为：',
    '{"code":"完整C程序源码","predictions":["第1条对应的输出","第2条对应的输出"]}',
    '',
    '════════ 题目：' + item.title + ' ════════',
    item.desc,
    '',
    '【输入格式】' + item.inputFmt,
    '【输出格式】' + item.outputFmt,
    '',
    '【示例】',
    '输入：',
    item.sample.in.trimEnd(),
    '输出：',
    item.sample.out,
    '',
    '【待预测输入】（只给出每条的输入，请给出对应输出）',
    hiddenList
  ].join('\n');
}

module.exports = {
  id: 'calgo',
  title: 'C 算法题（20 基础 + 6 陷阱题）',
  judge: 'exec',                       // 跑代码比对（可信度最高的一种判分）
  fields: { code: 'code', predictions: 'predictions' },
  prompt: buildPrompt,
  items: [
  {
    "id": "p01",
    "group": "basic",
    "title": "数组最大值与最小值",
    "desc": "读入 n 个整数，输出其中的最大值与最小值。",
    "inputFmt": "第一行一个整数 n（1≤n≤1000）；第二行 n 个整数，以空格分隔。",
    "outputFmt": "一行两个整数：最大值 最小值（用一个空格分隔）。",
    "sample": {
      "in": "5\n3 1 4 1 5\n",
      "out": "5 1"
    },
    "hidden": [
      {
        "in": "4\n-7 -2 -9 -3\n",
        "expected": "-2 -9"
      },
      {
        "in": "8\n100 42 42 7 1000 -5 0 3\n",
        "expected": "1000 -5"
      }
    ],
    "ref": "refs/p01.c"
  },
  {
    "id": "p02",
    "group": "basic",
    "title": "冒泡排序结果",
    "desc": "读入 n 个整数，用冒泡排序把它们从小到大排序后输出。",
    "inputFmt": "第一行一个整数 n（1≤n≤1000）；第二行 n 个整数。",
    "outputFmt": "一行 n 个整数，升序排列，用一个空格分隔，行末不要多余空格。",
    "sample": {
      "in": "5\n3 1 4 1 5\n",
      "out": "1 1 3 4 5"
    },
    "hidden": [
      {
        "in": "6\n9 8 7 6 5 4\n",
        "expected": "4 5 6 7 8 9"
      },
      {
        "in": "7\n0 -1 5 -1 3 3 2\n",
        "expected": "-1 -1 0 2 3 3 5"
      }
    ],
    "ref": "refs/p02.c"
  },
  {
    "id": "p03",
    "group": "basic",
    "title": "二分查找",
    "desc": "在一个升序数组中查找目标值，返回其下标（从 0 开始）；找不到返回 -1。若有多处出现，返回任意一个正确下标即可，但请用二分查找。",
    "inputFmt": "第一行整数 n（1≤n≤1000）；第二行 n 个升序排列的整数；第三行一个整数 k（要查找的目标）。",
    "outputFmt": "一行一个整数：目标值的下标，找不到输出 -1。",
    "sample": {
      "in": "5\n1 3 5 7 9\n5\n",
      "out": "2"
    },
    "hidden": [
      {
        "in": "6\n2 4 6 8 10 12\n7\n",
        "expected": "-1"
      },
      {
        "in": "1\n5\n5\n",
        "expected": "0"
      }
    ],
    "ref": "refs/p03.c"
  },
  {
    "id": "p04",
    "group": "basic",
    "title": "斐波那契数列第 n 项",
    "desc": "斐波那契数列定义为 F(1)=1, F(2)=1, F(n)=F(n-1)+F(n-2)。求第 n 项。",
    "inputFmt": "一个整数 n（1≤n≤80）。",
    "outputFmt": "一行一个整数：F(n)。",
    "sample": {
      "in": "10\n",
      "out": "55"
    },
    "hidden": [
      {
        "in": "1\n",
        "expected": "1"
      },
      {
        "in": "80\n",
        "expected": "23416728348467685"
      }
    ],
    "ref": "refs/p04.c"
  },
  {
    "id": "p05",
    "group": "basic",
    "title": "素数判定",
    "desc": "判断一个整数是否为素数（质数）。",
    "inputFmt": "一个整数 n（1≤n≤1000000）。",
    "outputFmt": "一行：是素数输出 YES，否则输出 NO。",
    "sample": {
      "in": "17\n",
      "out": "YES"
    },
    "hidden": [
      {
        "in": "1\n",
        "expected": "NO"
      },
      {
        "in": "999983\n",
        "expected": "YES"
      }
    ],
    "ref": "refs/p05.c"
  },
  {
    "id": "p06",
    "group": "basic",
    "title": "最大公约数",
    "desc": "用辗转相除法求两个正整数的最大公约数。",
    "inputFmt": "两个正整数 a 和 b（1≤a,b≤10^9），用空格分隔。",
    "outputFmt": "一行一个整数：gcd(a,b)。",
    "sample": {
      "in": "12 18\n",
      "out": "6"
    },
    "hidden": [
      {
        "in": "1000000000 999999999\n",
        "expected": "1"
      },
      {
        "in": "7 7\n",
        "expected": "7"
      }
    ],
    "ref": "refs/p06.c"
  },
  {
    "id": "p07",
    "group": "basic",
    "title": "字符串反转",
    "desc": "把输入的字符串反转后输出，并统计其长度（长度也输出）。",
    "inputFmt": "一行不含空格的字符串（长度 1~1000）。",
    "outputFmt": "第一行：反转后的字符串；第二行：原字符串长度。",
    "sample": {
      "in": "hello\n",
      "out": "olleh\n5"
    },
    "hidden": [
      {
        "in": "a\n",
        "expected": "a\n1"
      },
      {
        "in": "abcdefghij\n",
        "expected": "jihgfedcba\n10"
      }
    ],
    "ref": "refs/p07.c"
  },
  {
    "id": "p08",
    "group": "basic",
    "title": "字符分类统计",
    "desc": "统计一行字符串中英文字母、数字字符、其它字符（含空格与标点）的个数。",
    "inputFmt": "一行字符串（可能含空格，长度 1~1000）。",
    "outputFmt": "一行三个整数：字母个数 数字个数 其它字符个数（空格分隔）。",
    "sample": {
      "in": "abc123\n",
      "out": "3 3 0"
    },
    "hidden": [
      {
        "in": "Hello, World! 2024\n",
        "expected": "10 4 4"
      },
      {
        "in": "!!!\n",
        "expected": "0 0 3"
      }
    ],
    "ref": "refs/p08.c"
  },
  {
    "id": "p09",
    "group": "basic",
    "title": "矩阵转置",
    "desc": "读入一个 m 行 n 列的整数矩阵，输出它的转置（n 行 m 列）。",
    "inputFmt": "第一行两个整数 m n（1≤m,n≤100）；接下来 m 行，每行 n 个整数。",
    "outputFmt": "n 行，每行 m 个整数，同一行内用一个空格分隔。",
    "sample": {
      "in": "2 3\n1 2 3\n4 5 6\n",
      "out": "1 4\n2 5\n3 6"
    },
    "hidden": [
      {
        "in": "1 1\n7\n",
        "expected": "7"
      },
      {
        "in": "3 2\n1 2\n3 4\n5 6\n",
        "expected": "1 3 5\n2 4 6"
      }
    ],
    "ref": "refs/p09.c"
  },
  {
    "id": "p10",
    "group": "basic",
    "title": "汉诺塔最少移动次数",
    "desc": "n 个盘子的汉诺塔问题，最少需要移动多少次？",
    "inputFmt": "一个整数 n（1≤n≤60）。",
    "outputFmt": "一行一个整数：最少移动次数。",
    "sample": {
      "in": "3\n",
      "out": "7"
    },
    "hidden": [
      {
        "in": "1\n",
        "expected": "1"
      },
      {
        "in": "20\n",
        "expected": "1048575"
      }
    ],
    "ref": "refs/p10.c"
  },
  {
    "id": "p11",
    "group": "basic",
    "title": "各位数字之和",
    "desc": "求一个非负整数各位数字之和。",
    "inputFmt": "一个整数 n（0≤n≤10^18）。",
    "outputFmt": "一行一个整数：各位数字之和。",
    "sample": {
      "in": "12345\n",
      "out": "15"
    },
    "hidden": [
      {
        "in": "0\n",
        "expected": "0"
      },
      {
        "in": "900000000000000009\n",
        "expected": "18"
      }
    ],
    "ref": "refs/p11.c"
  },
  {
    "id": "p12",
    "group": "basic",
    "title": "回文字符串判断",
    "desc": "判断一个不含空格的字符串是否为回文（正读反读相同）。",
    "inputFmt": "一行不含空格的字符串（长度 1~1000）。",
    "outputFmt": "一行：是回文输出 YES，否则输出 NO。",
    "sample": {
      "in": "abcba\n",
      "out": "YES"
    },
    "hidden": [
      {
        "in": "abccba\n",
        "expected": "YES"
      },
      {
        "in": "abcab\n",
        "expected": "NO"
      }
    ],
    "ref": "refs/p12.c"
  },
  {
    "id": "p13",
    "group": "basic",
    "title": "合并两个升序数组",
    "desc": "把两个升序数组归并成一个升序数组。",
    "inputFmt": "第一行两个整数 n m；第二行 n 个升序整数；第三行 m 个升序整数。",
    "outputFmt": "一行 n+m 个升序整数，用一个空格分隔，行末不要多余空格。",
    "sample": {
      "in": "3 3\n1 3 5\n2 4 6\n",
      "out": "1 2 3 4 5 6"
    },
    "hidden": [
      {
        "in": "1 1\n5\n1\n",
        "expected": "1 5"
      },
      {
        "in": "4 2\n1 1 2 9\n1 3\n",
        "expected": "1 1 1 2 3 9"
      }
    ],
    "ref": "refs/p13.c"
  },
  {
    "id": "p14",
    "group": "basic",
    "title": "出现次数最多的数",
    "desc": "找出数组中出现次数最多的数。若有多个数出现次数相同，输出其中数值最小的那个。",
    "inputFmt": "第一行整数 n（1≤n≤1000）；第二行 n 个整数（-10^9~10^9）。",
    "outputFmt": "一行一个整数：出现次数最多的数。",
    "sample": {
      "in": "6\n3 3 1 1 2 2\n",
      "out": "1"
    },
    "hidden": [
      {
        "in": "7\n5 5 5 2 2 9 9\n",
        "expected": "5"
      },
      {
        "in": "1\n-3\n",
        "expected": "-3"
      }
    ],
    "ref": "refs/p14.c"
  },
  {
    "id": "p15",
    "group": "basic",
    "title": "十进制转二进制",
    "desc": "把一个非负整数转换成二进制字符串（不含前导 0，0 输出 0）。",
    "inputFmt": "一个整数 n（0≤n≤10^9）。",
    "outputFmt": "一行：n 的二进制表示。",
    "sample": {
      "in": "10\n",
      "out": "1010"
    },
    "hidden": [
      {
        "in": "0\n",
        "expected": "0"
      },
      {
        "in": "1023\n",
        "expected": "1111111111"
      }
    ],
    "ref": "refs/p15.c"
  },
  {
    "id": "p16",
    "group": "basic",
    "title": "最大子数组和",
    "desc": "求一个整数数组中连续子数组的最大和（子数组至少包含一个元素）。",
    "inputFmt": "第一行整数 n（1≤n≤1000）；第二行 n 个整数（绝对值 ≤10^6）。",
    "outputFmt": "一行一个整数：最大子数组和。",
    "sample": {
      "in": "8\n-2 1 -3 4 -1 2 1 -5\n",
      "out": "6"
    },
    "hidden": [
      {
        "in": "5\n-5 -2 -9 -1 -7\n",
        "expected": "-1"
      },
      {
        "in": "6\n1 2 3 4 5 6\n",
        "expected": "21"
      }
    ],
    "ref": "refs/p16.c"
  },
  {
    "id": "p17",
    "group": "basic",
    "title": "最长单词的长度",
    "desc": "一行由空格分隔的单词组成，求最长单词的长度（单词只由字母组成）。",
    "inputFmt": "一行字符串（含空格，长度 1~1000）。",
    "outputFmt": "一行一个整数：最长单词的长度。",
    "sample": {
      "in": "I love programming\n",
      "out": "11"
    },
    "hidden": [
      {
        "in": "a bb ccc dddd\n",
        "expected": "4"
      },
      {
        "in": "hello\n",
        "expected": "5"
      }
    ],
    "ref": "refs/p17.c"
  },
  {
    "id": "p18",
    "group": "basic",
    "title": "二进制中 1 的个数",
    "desc": "统计一个非负整数的二进制表示中 1 的个数。",
    "inputFmt": "一个整数 n（0≤n≤10^18）。",
    "outputFmt": "一行一个整数：1 的个数。",
    "sample": {
      "in": "13\n",
      "out": "3"
    },
    "hidden": [
      {
        "in": "0\n",
        "expected": "0"
      },
      {
        "in": "1099511627775\n",
        "expected": "40"
      }
    ],
    "ref": "refs/p18.c"
  },
  {
    "id": "p19",
    "group": "basic",
    "title": "数组去重（保持首次出现顺序）",
    "desc": "删除数组中重复出现的元素，只保留每个数第一次出现的位置，保持原有相对顺序。",
    "inputFmt": "第一行整数 n（1≤n≤1000）；第二行 n 个整数。",
    "outputFmt": "一行：去重后的序列，用一个空格分隔，行末不要多余空格。",
    "sample": {
      "in": "6\n1 2 1 3 2 4\n",
      "out": "1 2 3 4"
    },
    "hidden": [
      {
        "in": "5\n5 5 5 5 5\n",
        "expected": "5"
      },
      {
        "in": "7\n3 -1 3 2 -1 7 2\n",
        "expected": "3 -1 2 7"
      }
    ],
    "ref": "refs/p19.c"
  },
  {
    "id": "p20",
    "group": "basic",
    "title": "n! 末尾零的个数",
    "desc": "求 n 的阶乘末尾有多少个连续的 0（不要真的算出 n!，n 可能很大）。",
    "inputFmt": "一个整数 n（0≤n≤10^9）。",
    "outputFmt": "一行一个整数：末尾零的个数。",
    "sample": {
      "in": "10\n",
      "out": "2"
    },
    "hidden": [
      {
        "in": "0\n",
        "expected": "0"
      },
      {
        "in": "100\n",
        "expected": "24"
      }
    ],
    "ref": "refs/p20.c"
  },
  {
    "id": "h01",
    "group": "hard",
    "title": "大整数加法（最长 100 位）",
    "desc": "求两个非负整数之和。注意这两个数可能有 100 位，超出普通整数类型的范围。",
    "inputFmt": "两行，每行一个非负整数（不含前导零，位数 1~100）。",
    "outputFmt": "一行：两数之和（不含前导零；若结果为 0 则输出 0）。",
    "sample": {
      "in": "123\n456\n",
      "out": "579"
    },
    "hidden": [
      {
        "in": "99999999999999999999999999999999999999999999999999\n1\n",
        "expected": "100000000000000000000000000000000000000000000000000"
      },
      {
        "in": "123456789012345678901234567890\n987654321098765432109876543210\n",
        "expected": "1111111110111111111011111111100"
      }
    ],
    "ref": "refs/h01.c"
  },
  {
    "id": "h02",
    "group": "hard",
    "title": "约瑟夫环出列顺序",
    "desc": "n 个人围成一圈，编号 1..n。从 1 号开始报数，每次报到 m 的人出列，然后从出列者的下一个人重新从 1 开始报数，直到所有人出列。输出出列顺序。",
    "inputFmt": "两个整数 n 和 m（1≤n≤1000，1≤m≤1000），用空格分隔。",
    "outputFmt": "一行 n 个整数：出列顺序，用一个空格分隔，行末不要多余空格。",
    "sample": {
      "in": "5 2\n",
      "out": "2 4 1 5 3"
    },
    "hidden": [
      {
        "in": "7 3\n",
        "expected": "3 6 2 7 5 1 4"
      },
      {
        "in": "1 1\n",
        "expected": "1"
      }
    ],
    "ref": "refs/h02.c"
  },
  {
    "id": "h03",
    "group": "hard",
    "title": "区间合并",
    "desc": "给定 n 个闭区间 [l, r]，把所有\"重叠或相邻\"的区间合并成一个（例如 [1,3] 与 [4,6] 相邻，要合并成 [1,6]）。输出合并后的区间个数，以及合并后所有区间覆盖的总长度。",
    "inputFmt": "第一行一个整数 n（1≤n≤1000）；接下来 n 行，每行两个整数 l r（0≤l≤r≤100000）。",
    "outputFmt": "一行两个整数：合并后的区间个数 覆盖总长度（用一个空格分隔）。",
    "sample": {
      "in": "2\n1 3\n5 7\n",
      "out": "2 6"
    },
    "hidden": [
      {
        "in": "2\n1 3\n4 6\n",
        "expected": "1 6"
      },
      {
        "in": "3\n5 5\n1 2\n2 3\n",
        "expected": "2 4"
      }
    ],
    "ref": "refs/h03.c"
  },
  {
    "id": "h04",
    "group": "hard",
    "title": "分数加法（结果要约到最简）",
    "desc": "计算 a/b + c/d，结果写成最简分数形式。分母保证为正；分子可能为负。若结果为 0，输出 0/1。",
    "inputFmt": "一行四个整数 a b c d（1≤|a|,|c|≤1000，1≤b,d≤1000）。其中 b、d 为正。",
    "outputFmt": "一行两个整数：结果的最简分子 分母（分母恒为正，用空格分隔）。",
    "sample": {
      "in": "1 2 1 2\n",
      "out": "1 1"
    },
    "hidden": [
      {
        "in": "1 6 1 3\n",
        "expected": "1 2"
      },
      {
        "in": "-1 2 1 4\n",
        "expected": "-1 4"
      }
    ],
    "ref": "refs/h04.c"
  },
  {
    "id": "h05",
    "group": "hard",
    "title": "十进制转任意进制（2~36）",
    "desc": "把十进制非负整数 n 转换成 base 进制。数字 10 到 35 分别用大写字母 A 到 Z 表示。",
    "inputFmt": "两个整数 n 和 base（0≤n≤2000000000，2≤base≤36），用空格分隔。",
    "outputFmt": "一行：n 在 base 进制下的表示（不含前导零；n=0 时输出 0）。",
    "sample": {
      "in": "10 2\n",
      "out": "1010"
    },
    "hidden": [
      {
        "in": "255 16\n",
        "expected": "FF"
      },
      {
        "in": "35 36\n",
        "expected": "Z"
      }
    ],
    "ref": "refs/h05.c"
  },
  {
    "id": "h06",
    "group": "hard",
    "title": "两个日期相差的天数",
    "desc": "给定两个合法日期，求它们相差多少天（取绝对值）。注意闰年规则：能被 4 整除但不能被 100 整除，或者能被 400 整除的年份是闰年。",
    "inputFmt": "两行，每行三个整数 y m d（1900≤y≤2100），表示年 月 日。",
    "outputFmt": "一行一个整数：两个日期相差的天数。",
    "sample": {
      "in": "2020 1 1\n2020 1 2\n",
      "out": "1"
    },
    "hidden": [
      {
        "in": "2020 2 28\n2020 3 1\n",
        "expected": "2"
      },
      {
        "in": "1900 2 28\n1900 3 1\n",
        "expected": "1"
      }
    ],
    "ref": "refs/h06.c"
  }
  ]
};
