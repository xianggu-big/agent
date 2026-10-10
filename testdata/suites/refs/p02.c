#include <stdio.h>
int main(void){
    int n, a[1005], i, j, t;
    if (scanf("%d", &n) != 1) return 0;
    for (i = 0; i < n; i++) if (scanf("%d", &a[i]) != 1) break;
    for (i = 0; i < n - 1; i++)
        for (j = 0; j < n - 1 - i; j++)
            if (a[j] > a[j + 1]) { t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; }
    for (i = 0; i < n; i++) printf(i ? " %d" : "%d", a[i]);
    printf("\n");
    return 0;
}
