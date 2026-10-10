#include <stdio.h>
int main(void){
    int m, n, a[105][105], i, j;
    if (scanf("%d %d", &m, &n) != 2) return 0;
    for (i = 0; i < m; i++) for (j = 0; j < n; j++) if (scanf("%d", &a[i][j]) != 1) return 0;
    for (j = 0; j < n; j++) {
        for (i = 0; i < m; i++) printf(i ? " %d" : "%d", a[i][j]);
        printf("\n");
    }
    return 0;
}
