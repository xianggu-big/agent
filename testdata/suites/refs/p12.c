#include <stdio.h>
#include <string.h>
int main(void){
    char s[1005];
    int i, n, ok = 1;
    if (scanf("%1000s", s) != 1) return 0;
    n = (int)strlen(s);
    for (i = 0; i < n / 2; i++) if (s[i] != s[n - 1 - i]) { ok = 0; break; }
    printf("%s\n", ok ? "YES" : "NO");
    return 0;
}
