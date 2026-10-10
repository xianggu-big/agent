#include <stdio.h>
int main(void){
    int n, L[1005], R[1005], i, j;
    if (scanf("%d", &n) != 1) return 0;
    for (i = 0; i < n; i++) if (scanf("%d %d", &L[i], &R[i]) != 2) return 0;
    /* 按左端点排序（简单选择排序，n≤1000） */
    for (i = 0; i < n - 1; i++)
        for (j = 0; j < n - 1 - i; j++)
            if (L[j] > L[j + 1]) {
                int t = L[j]; L[j] = L[j + 1]; L[j + 1] = t;
                t = R[j]; R[j] = R[j + 1]; R[j + 1] = t;
            }
    long long cnt = 0, total = 0;
    int cl = L[0], cr = R[0];
    for (i = 1; i < n; i++) {
        if (L[i] <= cr + 1) { if (R[i] > cr) cr = R[i]; }
        else { cnt++; total += (long long)(cr - cl + 1); cl = L[i]; cr = R[i]; }
    }
    cnt++; total += (long long)(cr - cl + 1);
    printf("%lld %lld\n", cnt, total);
    return 0;
}
