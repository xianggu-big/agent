#include <stdio.h>
int main(void){
    int n, m, a[1005], b[1005], i, j, first = 1;
    if (scanf("%d %d", &n, &m) != 2) return 0;
    for (i = 0; i < n; i++) if (scanf("%d", &a[i]) != 1) break;
    for (j = 0; j < m; j++) if (scanf("%d", &b[j]) != 1) break;
    i = j = 0;
    while (i < n || j < m) {
        int v;
        if (j >= m || (i < n && a[i] <= b[j])) v = a[i++]; else v = b[j++];
        printf(first ? "%d" : " %d", v);
        first = 0;
    }
    printf("\n");
    return 0;
}
