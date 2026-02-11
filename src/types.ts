export type OneBotMessageSegment =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { file: string; url?: string } }
  | { type: "record"; data: { file: string } }
  | {
      type: "file";
      data: {
        file?: string;
        name?: string;
        url?: string;
        file_id?: string;
        busid?: number | string;
        file_size?: number;
      };
    }
  | { type: "at"; data: { qq: string } }
  | { type: "reply"; data: { id: string } };

export type OneBotMessage = OneBotMessageSegment[];

export type OneBotEvent = {
  time: number;
  self_id: number;
  post_type: string;
  meta_event_type?: string;
  message_type?: "private" | "group" | "guild";
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  message?: OneBotMessage | string;
  raw_message?: string;
  sender?: {
    user_id: number;
    nickname: string;
    card?: string;
    role?: string;
  };
};
