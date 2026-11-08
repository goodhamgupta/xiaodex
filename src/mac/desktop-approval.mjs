import { DesktopIpcApprovalClient } from "./desktop-ipc-approval.mjs";

export class DesktopApprovalController {
  constructor(options = {}) {
    const { ipc, ...ipcOptions } = options;
    this.ipc = ipc || new DesktopIpcApprovalClient(ipcOptions);
  }

  respond(decision, context = {}) {
    if (decision !== "once" && decision !== "deny") {
      throw new TypeError('Desktop approval decision must be "once" or "deny"');
    }
    return this.ipc.respond(decision === "deny" ? "decline" : "accept", context);
  }
}
