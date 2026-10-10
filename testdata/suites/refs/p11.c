#include <stdio.h>
int main(void){
    unsigned long long n, s = 0;
    if (scanf("%llu", &n) != 1) return 0;
    while (n) { s += n % 10; n /= 10; }
    printf("%llu\n", s);
    return 0;
}
