#include <stdio.h>
int main(void){
    long long a, b, t;
    if (scanf("%lld %lld", &a, &b) != 2) return 0;
    while (b) { t = a % b; a = b; b = t; }
    printf("%lld\n", a);
    return 0;
}
