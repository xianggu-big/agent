#include <stdio.h>
int main(void){
    long long n, a[1005], i, j, best = 0, bestCnt = 0;
    if (scanf("%lld", &n) != 1) return 0;
    for (i = 0; i < n; i++) if (scanf("%lld", &a[i]) != 1) break;
    for (i = 0; i < n; i++) {
        long long c = 0;
        for (j = 0; j < n; j++) if (a[j] == a[i]) c++;
        if (c > bestCnt || (c == bestCnt && a[i] < best)) { bestCnt = c; best = a[i]; }
    }
    printf("%lld\n", best);
    return 0;
}
