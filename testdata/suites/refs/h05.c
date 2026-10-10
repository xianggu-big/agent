#include <stdio.h>
int main(void){
    long long n, base;
    char buf[80], digits[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    int k = 0;
    if (scanf("%lld %lld", &n, &base) != 2) return 0;
    if (n == 0) { printf("0\n"); return 0; }
    while (n > 0) { buf[k++] = digits[n % base]; n /= base; }
    while (k--) putchar(buf[k]);
    putchar('\n');
    return 0;
}
