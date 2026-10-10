#include <stdio.h>
#include <string.h>
int main(void){
    char s[1005];
    int i, n;
    if (scanf("%1000s", s) != 1) return 0;
    n = (int)strlen(s);
    for (i = n - 1; i >= 0; i--) putchar(s[i]);
    putchar('\n');
    printf("%d\n", n);
    return 0;
}
