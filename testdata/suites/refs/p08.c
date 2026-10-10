#include <stdio.h>
int main(void){
    char line[2005];
    int letters = 0, digits = 0, others = 0, i;
    if (!fgets(line, sizeof(line), stdin)) return 0;
    for (i = 0; line[i] && line[i] != '\n'; i++) {
        char c = line[i];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) letters++;
        else if (c >= '0' && c <= '9') digits++;
        else others++;
    }
    printf("%d %d %d\n", letters, digits, others);
    return 0;
}
