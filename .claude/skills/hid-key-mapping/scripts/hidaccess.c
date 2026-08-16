// Checks (and optionally requests) TCC "Input Monitoring" for the hosting app.
// Build: clang -o hidaccess hidaccess.c -framework IOKit -framework CoreFoundation
#include <stdio.h>
#include <string.h>

typedef unsigned int IOHIDRequestType_t;
typedef unsigned int IOHIDAccessType_t;

#define kIOHIDRequestTypeListenEvent 1

extern IOHIDAccessType_t IOHIDCheckAccess(IOHIDRequestType_t requestType);
extern int IOHIDRequestAccess(IOHIDRequestType_t requestType);

static const char *name(IOHIDAccessType_t a) {
  switch (a) {
    case 0: return "GRANTED";
    case 1: return "DENIED";
    case 2: return "UNKNOWN (never prompted)";
    default: return "?";
  }
}

int main(int argc, char **argv) {
  IOHIDAccessType_t a = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent);
  printf("Input Monitoring (listen-event) access: %s (%u)\n", name(a), a);

  if (argc > 1 && strcmp(argv[1], "--request") == 0) {
    printf("requesting access (may show a system prompt)...\n");
    int ok = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent);
    printf("IOHIDRequestAccess returned: %d\n", ok);
    a = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent);
    printf("access now: %s (%u)\n", name(a), a);
  }
  return 0;
}
