#include <stdio.h>
static long long gcd(long long a, long long b) {
    if (a < 0) a = -a; if (b < 0) b = -b;
    while (b) { long long t = a % b; a = b; b = t; }
    return a;
}
int main(void){
    long long a, b, c, d;
    if (scanf("%lld %lld %lld %lld", &a, &b, &c, &d) != 4) return 0;
    long long num = a * d + c * b;
    long long den = b * d;
    if (num == 0) { printf("0 1\n"); return 0; }
    long long g = gcd(num, den);
    num /= g; den /= g;
    if (den < 0) { num = -num; den = -den; }
    printf("%lld %lld\n", num, den);
    return 0;
}
