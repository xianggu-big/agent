#include <stdio.h>
int main(void){
    int n, x, mx, mn, i;
    if (scanf("%d", &n) != 1) return 0;
    if (scanf("%d", &x) != 1) return 0;
    mx = mn = x;
    for (i = 1; i < n; i++) { if (scanf("%d", &x) != 1) break; if (x > mx) mx = x; if (x < mn) mn = x; }
    printf("%d %d\n", mx, mn);
    return 0;
}
