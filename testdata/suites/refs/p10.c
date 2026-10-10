#include <stdio.h>
int main(void){
    int n, i;
    unsigned long long r = 1;
    if (scanf("%d", &n) != 1) return 0;
    for (i = 0; i < n; i++) r *= 2;
    printf("%llu\n", r - 1);
    return 0;
}
