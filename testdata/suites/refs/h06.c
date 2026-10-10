#include <stdio.h>
static int isLeap(int y) { return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0; }
static long long daysFrom(int y, int m, int d) {
    int mdays[13] = {0,31,28,31,30,31,30,31,31,30,31,30,31};
    long long days = 0; int i;
    for (i = 1900; i < y; i++) days += isLeap(i) ? 366 : 365;
    for (i = 1; i < m; i++) { days += mdays[i]; if (i == 2 && isLeap(y)) days++; }
    days += d - 1;
    return days;
}
int main(void){
    int y1, m1, d1, y2, m2, d2;
    if (scanf("%d %d %d", &y1, &m1, &d1) != 3) return 0;
    if (scanf("%d %d %d", &y2, &m2, &d2) != 3) return 0;
    long long a = daysFrom(y1, m1, d1), b = daysFrom(y2, m2, d2);
    long long diff = a > b ? a - b : b - a;
    printf("%lld\n", diff);
    return 0;
}
