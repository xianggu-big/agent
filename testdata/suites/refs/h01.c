#include <stdio.h>
#include <string.h>
int main(void){
    char a[205], b[205];
    int ra[205] = {0}, rb[205] = {0}, res[210] = {0};
    if (scanf("%200s", a) != 1) return 0;
    if (scanf("%200s", b) != 1) return 0;
    int la = (int)strlen(a), lb = (int)strlen(b), i;
    for (i = 0; i < la; i++) ra[i] = a[la - 1 - i] - '0';
    for (i = 0; i < lb; i++) rb[i] = b[lb - 1 - i] - '0';
    int n = la > lb ? la : lb, carry = 0;
    for (i = 0; i < n; i++) { int s = ra[i] + rb[i] + carry; res[i] = s % 10; carry = s / 10; }
    if (carry) res[n++] = carry;
    while (n > 1 && res[n - 1] == 0) n--;
    for (i = n - 1; i >= 0; i--) putchar('0' + res[i]);
    putchar('\n');
    return 0;
}
