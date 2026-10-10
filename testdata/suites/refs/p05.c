#include <stdio.h>
int main(void){
    long long n, i; int ok = 1;
    if (scanf("%lld", &n) != 1) return 0;
    if (n < 2) ok = 0;
    for (i = 2; i * i <= n; i++) if (n % i == 0) { ok = 0; break; }
    printf("%s\n", ok ? "YES" : "NO");
    return 0;
}
