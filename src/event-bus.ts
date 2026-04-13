import { EventEmitter } from 'events';

export type NanoClawEvent =
  | {
      type: 'container_start';
      groupFolder: string;
      containerName: string;
      timestamp: string;
    }
  | {
      type: 'container_end';
      groupFolder: string;
      containerName: string;
      duration: number;
      exitCode: number | null;
      timestamp: string;
    }
  | {
      type: 'container_stderr';
      groupFolder: string;
      chunk: string;
      timestamp: string;
    }
  | {
      type: 'container_output';
      groupFolder: string;
      result: string | null;
      timestamp: string;
    }
  | {
      type: 'queue_start';
      groupJid: string;
      reason: string;
      activeCount: number;
      timestamp: string;
    }
  | {
      type: 'agent_output';
      groupFolder: string;
      text: string;
      timestamp: string;
    }
  | {
      type: 'ipc_message_sent';
      chatJid: string;
      sourceGroup: string;
      timestamp: string;
    }
  | {
      type: 'message_received';
      chatJid: string;
      sender: string;
      timestamp: string;
    }
  | {
      type: 'task_started';
      taskId: string;
      groupFolder: string;
      timestamp: string;
    }
  | {
      type: 'task_completed';
      taskId: string;
      groupFolder: string;
      duration: number;
      status: string;
      timestamp: string;
    };

class NanoClawEventBus extends EventEmitter {
  emit(event: 'event', data: NanoClawEvent): boolean {
    return super.emit('event', data);
  }

  on(event: 'event', listener: (data: NanoClawEvent) => void): this {
    return super.on('event', listener);
  }
}

export const eventBus = new NanoClawEventBus();
