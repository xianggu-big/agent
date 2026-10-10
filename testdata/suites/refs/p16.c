#include <stdio.h>
int main(void){
    int n, i, x, best, cur;
    if (scanf("%d", &n) != 1) return 0;
    if (scanf("%d", &x) != 1) return 0;
    best = cur = x;
    for (i = 1; i < n; i++) {
        if (scanf("%d", &x) != 1) break;
        cur = (cur > 0 ? cur : 0) + x;
        if (cur > best) best = cur;
    }
    printf("%d\n", best);
    return 0;
}
