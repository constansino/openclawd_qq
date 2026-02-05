import WebSocket from "ws";
import EventEmitter from "events";
import type { OneBotEvent, OneBotMessage } from "./types.js";

interface OneBotClientOptions {
  wsUrl: string;
  accessToken?: string;
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: OneBotClientOptions;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 60000; // Max 1 minute delay

  constructor(options: OneBotClientOptions) {
    super();
    this.options = options;
  }

  getSelfId(): number | null {
    return this.selfId;
  }

  setSelfId(id: number) {
    this.selfId = id;
  }

  connect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const headers: Record<string, string> = {};
    if (this.options.accessToken) {
      headers["Authorization"] = `Bearer ${this.options.accessToken}`;
    }

    this.ws = new WebSocket(this.options.wsUrl, { headers });

    this.ws.on("open", () => {
      this.isAlive = true;
      this.reconnectAttempts = 0; // Reset counter on success
      this.emit("connect");
      console.log("[QQ] Connected to OneBot server");
    });

    this.ws.on("message", (data) => {
      try {
        const payload = JSON.parse(data.toString()) as OneBotEvent;
        if (payload.post_type === "meta_event" && payload.meta_event_type === "heartbeat") {
          this.isAlive = true;
          return;
        }
        this.emit("message", payload);
      } catch (err) {
        console.error("[QQ] Failed to parse message:", err);
      }
    });

    this.ws.on("close", () => {
      this.isAlive = false;
      this.emit("disconnect");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("[QQ] WebSocket error:", err);
      this.ws?.close();
    });
  }

  private scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    console.log(`[QQ] Reconnecting in ${delay / 1000}s (Attempt ${this.reconnectAttempts + 1})...`);
    
    this.reconnectTimer = setTimeout(() => {
        this.reconnectAttempts++;
        this.connect();
    }, delay);
  }

  sendPrivateMsg(userId: number, message: OneBotMessage | string) {
    this.send("send_private_msg", { user_id: userId, message });
  }

  sendGroupMsg(groupId: number, message: OneBotMessage | string) {
    this.send("send_group_msg", { group_id: groupId, message });
  }

  deleteMsg(messageId: number | string) {
    this.send("delete_msg", { message_id: messageId });
  }

  setGroupAddRequest(flag: string, subType: string, approve: boolean = true, reason: string = "") {
    this.send("set_group_add_request", { flag, sub_type: subType, approve, reason });
  }

  setFriendAddRequest(flag: string, approve: boolean = true, remark: string = "") {
    this.send("set_friend_add_request", { flag, approve, remark });
  }

  async getLoginInfo(): Promise<any> {
    return this.sendWithResponse("get_login_info", {});
  }

  async getMsg(messageId: number | string): Promise<any> {
    return this.sendWithResponse("get_msg", { message_id: messageId });
  }

  // Note: get_group_msg_history is extended API supported by go-cqhttp/napcat
  async getGroupMsgHistory(groupId: number): Promise<any> {
    return this.sendWithResponse("get_group_msg_history", { group_id: groupId });
  }

  private sendWithResponse(action: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not open"));
        return;
      }

      const echo = Math.random().toString(36).substring(2, 15);
      const handler = (data: WebSocket.RawData) => {
        try {
          const resp = JSON.parse(data.toString());
          if (resp.echo === echo) {
            this.ws?.off("message", handler);
            if (resp.status === "ok") {
              resolve(resp.data);
            } else {
              reject(new Error(resp.msg || "API request failed"));
            }
          }
        } catch (err) {
          // Ignore non-JSON messages
        }
      };

      this.ws.on("message", handler);
      this.ws.send(JSON.stringify({ action, params, echo }));

      // Timeout after 5 seconds
      setTimeout(() => {
        this.ws?.off("message", handler);
        reject(new Error("Request timeout"));
      }, 5000);
    });
  }

  private send(action: string, params: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action, params }));
    } else {
      console.warn("[QQ] Cannot send message, WebSocket not open");
    }
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
