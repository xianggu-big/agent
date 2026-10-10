#include <stdio.h>
int main(void){
    char line[2005];
    int i, cur = 0, best = 0;
    if (!fgets(line, sizeof(line), stdin)) return 0;
    for (i = 0; line[i] && line[i] != '\n'; i++) {
        if (line[i] == ' ' || line[i] == '\t') { if (cur > best) best = cur; cur = 0; }
        else cur++;
    }
    if (cur > best) best = cur;
    printf("%d\n", best);
    return 0;
}
