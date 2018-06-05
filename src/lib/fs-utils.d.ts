export function writeAndSyncFile(path: string, data: string): Promise<void>;
export function writeFileAtomic(path: string, data: string): Promise<void>;
export function safeRename(src: string, dest: string): Promise<void>;
