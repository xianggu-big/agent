#include <stdio.h>
int main(void){
    int n, m, alive[1005], i, cnt = 0, idx = 0, out = 0, first = 1;
    if (scanf("%d %d", &n, &m) != 2) return 0;
    for (i = 0; i < n; i++) alive[i] = 1;
    while (out < n) {
        if (alive[idx]) {
            cnt++;
            if (cnt == m) {
                printf(first ? "%d" : " %d", idx + 1);
                first = 0;
                alive[idx] = 0; out++; cnt = 0;
            }
        }
        idx = (idx + 1) % n;
    }
    printf("\n");
    return 0;
}
