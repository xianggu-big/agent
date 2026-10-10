#include <stdio.h>
int main(void){
    unsigned long long n;
    char buf[80];
    int k = 0;
    if (scanf("%llu", &n) != 1) return 0;
    if (n == 0) { printf("0\n"); return 0; }
    while (n) { buf[k++] = (char)('0' + (n & 1)); n >>= 1; }
    while (k--) putchar(buf[k]);
    putchar('\n');
    return 0;
}
