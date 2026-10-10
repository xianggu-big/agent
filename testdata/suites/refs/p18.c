#include <stdio.h>
int main(void){
    unsigned long long n;
    int c = 0;
    if (scanf("%llu", &n) != 1) return 0;
    while (n) { c += (int)(n & 1ULL); n >>= 1; }
    printf("%d\n", c);
    return 0;
}
