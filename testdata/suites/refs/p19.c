#include <stdio.h>
int main(void){
    long long n, a[1005], i, j, first = 1;
    if (scanf("%lld", &n) != 1) return 0;
    for (i = 0; i < n; i++) if (scanf("%lld", &a[i]) != 1) break;
    for (i = 0; i < n; i++) {
        int seen = 0;
        for (j = 0; j < i; j++) if (a[j] == a[i]) { seen = 1; break; }
        if (!seen) { printf(first ? "%lld" : " %lld", a[i]); first = 0; }
    }
    printf("\n");
    return 0;
}
