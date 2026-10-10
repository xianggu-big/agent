#include <stdio.h>
int main(void){
    int n, a[1005], k, i, lo, hi, mid, ans = -1;
    if (scanf("%d", &n) != 1) return 0;
    for (i = 0; i < n; i++) if (scanf("%d", &a[i]) != 1) break;
    if (scanf("%d", &k) != 1) return 0;
    lo = 0; hi = n - 1;
    while (lo <= hi) {
        mid = (lo + hi) / 2;
        if (a[mid] == k) { ans = mid; break; }
        else if (a[mid] < k) lo = mid + 1;
        else hi = mid - 1;
    }
    printf("%d\n", ans);
    return 0;
}
