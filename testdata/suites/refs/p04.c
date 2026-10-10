#include <stdio.h>
int main(void){
    int n, i;
    unsigned long long a = 1, b = 1, c;
    if (scanf("%d", &n) != 1) return 0;
    if (n <= 2) { printf("1\n"); return 0; }
    for (i = 3; i <= n; i++) { c = a + b; a = b; b = c; }
    printf("%llu\n", b);
    return 0;
}
