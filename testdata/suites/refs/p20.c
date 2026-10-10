#include <stdio.h>
int main(void){
    long long n, c = 0, p = 5;
    if (scanf("%lld", &n) != 1) return 0;
    while (p <= n) { c += n / p; p *= 5; }
    printf("%lld\n", c);
    return 0;
}
