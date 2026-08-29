export interface MigrateSessionLogResult {
  migratedFiles: number
  removedEvents: number
  skipped: number
}

export declare function migrateSessionLog(homeOverride?: string): Promise<MigrateSessionLogResult>
