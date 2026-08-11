const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 💬 대화 및 메시지 관련
  sendMessage: (targetIP, message, urgent) => ipcRenderer.invoke('send-message', { targetIP, message, urgent }),
  sendFileTransfer: (opts) => ipcRenderer.invoke('send-file-transfer', opts),
  sendBroadcastMessage: (message) => ipcRenderer.invoke('send-broadcast-message', message),
  sendDeptMessage: (dept, message) => ipcRenderer.invoke('send-dept-message', { dept, message }),
  sendFloorMessage: (floor, message) => ipcRenderer.invoke('send-floor-message', { floor, message }),
  sendTransportRequest: (ward, patientName, treatmentName, treatmentLocation, treatmentTime, remarks) => ipcRenderer.invoke('send-transport-request', { ward, patientName, treatmentName, treatmentLocation, treatmentTime, remarks }),
  editTransportRequest: (localId, remoteId, ward, patientName, treatmentName, treatmentLocation, treatmentTime, remarks) => ipcRenderer.invoke('edit-transport-request', { localId, remoteId, ward, patientName, treatmentName, treatmentLocation, treatmentTime, remarks }),
  deleteTransportRequest: (localId, remoteId) => ipcRenderer.invoke('delete-transport-request', { localId, remoteId }),
  getTransportRequestHistory: (keyword) => ipcRenderer.invoke('get-transport-request-history', keyword),
  syncTransportRequestStatuses: () => ipcRenderer.invoke('sync-transport-request-statuses'),
  getTransportWebappUrl: () => ipcRenderer.invoke('get-transport-webapp-url'),
  setTransportWebappUrl: (url) => ipcRenderer.invoke('set-transport-webapp-url', url),
  notifyRead: (targetIP, opts) => ipcRenderer.invoke('notify-read', {
    targetIP,
    intentional: !!(opts && opts.intentional)
  }),
  notifyChannelRead: (channelKey, lastReadMsgUid) => ipcRenderer.invoke('notify-channel-read', { channelKey, lastReadMsgUid }),
  getMessageUnreadCounts: (channelKey, messages) => ipcRenderer.invoke('get-message-unread-counts', { channelKey, messages }),
  onChannelReadUpdate: (callback) => ipcRenderer.on('channel-read-update', (e, data) => callback(data)),
  getChatHistory: (targetIP, dateStr, keyword) => ipcRenderer.invoke('get-chat-history', { targetIP, dateStr, keyword }),
  getChatMessageDates: (targetIP, month) => ipcRenderer.invoke('get-chat-message-dates', { targetIP, month }),
  getRecentConversations: () => ipcRenderer.invoke('get-recent-conversations'),
  getChatSharedArchive: (targetIP) => ipcRenderer.invoke('get-chat-shared-archive', targetIP),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  clearChatView: (channelKey) => ipcRenderer.invoke('clear-chat-view', channelKey),
  getAllChatHistory: (opts) => ipcRenderer.invoke('get-all-chat-history', opts),

  // 👥 그룹 대화방
  createGroupChat: (name, memberIps) => ipcRenderer.invoke('create-group-chat', { name, memberIps }),
  getGroupChats: () => ipcRenderer.invoke('get-group-chats'),
  addGroupMember: (uid, ip) => ipcRenderer.invoke('add-group-member', { uid, ip }),
  renameGroupChat: (uid, name) => ipcRenderer.invoke('rename-group-chat', { uid, name }),
  leaveGroupChat: (uid) => ipcRenderer.invoke('leave-group-chat', { uid }),
  sendGroupMessage: (uid, groupName, message) => ipcRenderer.invoke('send-group-message', { uid, groupName, message }),
  editMessage: (msgUid, targetIP, groupUid, newMessage) => ipcRenderer.invoke('edit-message', { msgUid, targetIP, groupUid, newMessage }),
  toggleMessageReaction: (msgKey, emoji, targetIP, groupUid) => ipcRenderer.invoke('toggle-message-reaction', { msgKey, emoji, targetIP, groupUid }),
  getMessageReactions: (keys) => ipcRenderer.invoke('get-message-reactions', { keys }),
  onMessageReactionUpdate: (callback) => ipcRenderer.on('message-reaction-update', (e, data) => callback(data)),
  onMessageEdited: (callback) => ipcRenderer.on('message-edited', (e, data) => callback(data)),
  onMessageDelivered: (callback) => ipcRenderer.on('message-delivered', (e, data) => callback(data)),

  // ⏰ 예약 메시지
  scheduleMessage: (data) => ipcRenderer.invoke('schedule-message', data),
  getScheduledMessages: (targetIP) => ipcRenderer.invoke('get-scheduled-messages', targetIP),
  cancelScheduledMessage: (id) => ipcRenderer.invoke('cancel-scheduled-message', id),
  flushDueScheduledMessages: () => ipcRenderer.invoke('flush-due-scheduled-messages'),

  // 👤 프로필 및 연락처 (휴대폰 번호 포함)
  getMyProfile: () => ipcRenderer.invoke('get-my-profile'),
  getProfilePhoto: (ip) => ipcRenderer.invoke('get-profile-photo', ip),
  saveMyProfile: (profile) => ipcRenderer.invoke('save-my-profile', profile),

  // 📢 공지사항 게시판
  getNotices: () => ipcRenderer.invoke('get-notices'),
  getNotice: (uid) => ipcRenderer.invoke('get-notice', uid),
  addNotice: (noticeData) => ipcRenderer.invoke('add-notice', noticeData),
  requestNoticeSync: () => ipcRenderer.invoke('request-notice-sync'),
  updateNotice: (noticeData) => ipcRenderer.invoke('update-notice', noticeData),
  deleteNotice: (uid) => ipcRenderer.invoke('delete-notice', uid),

  // 📅 회사 공용 일정(달력)
  getSchedules: () => ipcRenderer.invoke('get-schedules'),
  exportScheduleBoardExcel: (payload) => ipcRenderer.invoke('export-schedule-board-excel', payload),
  openScheduleBoardWindow: (payload) => {
    const p = typeof payload === 'string' ? { dateStr: payload } : (payload || {});
    return ipcRenderer.invoke('open-schedule-board-window', p);
  },
  closeScheduleBoardWindow: () => ipcRenderer.invoke('close-schedule-board-window'),
  openExcalidrawEditor: (purpose) => ipcRenderer.invoke('open-excalidraw-editor', purpose || 'chat'),
  onExcalidrawPngReady: (callback) => ipcRenderer.on('excalidraw-png-ready', (e, data) => callback(data)),
  onScheduleBoardOpen: (callback) => ipcRenderer.on('schedule-board-open', (e, data) => callback(data)),
  addSchedule: (data) => ipcRenderer.invoke('add-schedule', data),
  deleteSchedule: (uid) => ipcRenderer.invoke('delete-schedule', uid),
  editSchedule: (payload) => ipcRenderer.invoke('edit-schedule', payload),

  // 🔒 마스터 관리자 및 공지·일정 작성 권한 계정(아이디/비밀번호) 관리
  verifyMasterAuth: (data) => ipcRenderer.invoke('verify-master-auth', data),
  verifyMasterPassword: (password) => ipcRenderer.invoke('verify-master-password', password),
  changeMasterPassword: (data) => ipcRenderer.invoke('change-master-password', data),
  changeNoticeOperatorPassword: (data) => ipcRenderer.invoke('change-notice-operator-password', data),
  resetNoticeOperatorPassword: (data) => ipcRenderer.invoke('reset-notice-operator-password', data),
  clearMasterSession: () => ipcRenderer.invoke('clear-master-session'),
  masterUpdateUserProfile: (payload) => ipcRenderer.invoke('master-update-user-profile', payload),
  masterForceUpdate: (payload) => ipcRenderer.invoke('master-force-update', payload),
  getUsageLockState: () => ipcRenderer.invoke('get-usage-lock-state'),
  getServicePauseState: () => ipcRenderer.invoke('get-service-pause-state'),
  setServicePause: (payload) => ipcRenderer.invoke('set-service-pause', payload),
  unlockServicePause: (payload) => ipcRenderer.invoke('unlock-service-pause', payload),
  getDisabledClients: () => ipcRenderer.invoke('get-disabled-clients'),
  unlockUsageWithMaster: (payload) => ipcRenderer.invoke('unlock-usage-with-master', payload),
  masterSetClientUsage: (payload) => ipcRenderer.invoke('master-set-client-usage', payload),
  masterWipeClientLogs: (payload) => ipcRenderer.invoke('master-wipe-client-logs', payload),
  getPendingRemoteWipes: () => ipcRenderer.invoke('get-pending-remote-wipes'),
  cancelPendingRemoteWipe: (targetIp) => ipcRenderer.invoke('cancel-pending-remote-wipe', targetIp),
  getPeerTrafficStats: () => ipcRenderer.invoke('get-peer-traffic-stats'),
  resetPeerTrafficStats: () => ipcRenderer.invoke('reset-peer-traffic-stats'),
  runLoadSim: (payload) => ipcRenderer.invoke('run-load-sim', payload),
  getLoadSimStatus: () => ipcRenderer.invoke('get-load-sim-status'),
  onUsageLockState: (callback) => ipcRenderer.on('usage-lock-state', (e, data) => callback(data)),
  onServicePauseState: (callback) => ipcRenderer.on('service-pause-state', (e, data) => callback(data)),
  onUsageLockResult: (callback) => ipcRenderer.on('usage-lock-result', (e, data) => callback(data)),
  onDisabledClientsUpdated: (callback) => ipcRenderer.on('disabled-clients-updated', (e, data) => callback(data)),
  onWipeChatHistoryResult: (callback) => ipcRenderer.on('wipe-chat-history-result', (e, data) => callback(data)),
  onChatHistoryWipeStarted: (callback) => ipcRenderer.on('chat-history-wipe-started', (e, data) => callback(data)),
  onChatHistoryWiped: (callback) => ipcRenderer.on('chat-history-wiped', (e, data) => callback(data)),
  onPendingRemoteWipesUpdated: (callback) => ipcRenderer.on('pending-remote-wipes-updated', (e, data) => callback(data)),
  onForceUpdateStarted: (callback) => ipcRenderer.on('force-update-started', (e, data) => callback(data)),
  onForceUpdateFailed: (callback) => ipcRenderer.on('force-update-failed', (e, data) => callback(data)),
  onForceUpdateResult: (callback) => ipcRenderer.on('force-update-result', (e, data) => callback(data)),
  getNoticeOperators: () => ipcRenderer.invoke('get-notice-operators'),
  addNoticeOperator: (data) => ipcRenderer.invoke('add-notice-operator', data),
  updateNoticeOperatorDisplayName: (data) => ipcRenderer.invoke('update-notice-operator-display-name', data),
  deleteNoticeOperator: (username) => ipcRenderer.invoke('delete-notice-operator', username),
  setNoticeOperatorDutyPerm: (data) => ipcRenderer.invoke('set-notice-operator-duty-perm', data),
  noticeOperatorLogin: (data) => ipcRenderer.invoke('notice-operator-login', data),
  setNoticeOperatorSession: (active, canManageDuty, meta) => ipcRenderer.invoke('set-notice-operator-session', active, canManageDuty, meta),

  // 📌 채널·1:1 공지 고정
  getChatPin: (channelKey) => ipcRenderer.invoke('get-chat-pin', channelKey),
  setChatPin: (payload) => ipcRenderer.invoke('set-chat-pin', payload),
  clearChatPin: (channelKey) => ipcRenderer.invoke('clear-chat-pin', channelKey),
  onChatPinsUpdate: (callback) => ipcRenderer.on('chat-pins-update', (e) => callback()),
  onDbCorruptRecovery: (callback) => ipcRenderer.on('db-corrupt-recovery', (e, data) => callback(data)),
  onDbCorruptionDetected: (callback) => ipcRenderer.on('db-corruption-detected', (e, data) => callback(data)),
  getDbCorruptionStatus: () => ipcRenderer.invoke('get-db-corruption-status'),

  // 🩺 당직의 / 의료진 OFF
  getDutyRoster: (dateStr) => ipcRenderer.invoke('get-duty-roster', dateStr),
  setDutyRosterForDate: (payload) => ipcRenderer.invoke('set-duty-roster-for-date', payload),
  onDutyRosterUpdate: (callback) => ipcRenderer.on('duty-roster-update', (e) => callback()),

  // 💻 시스템 설정 (자동 부팅, 창 뷰모드, DB 백업)
  setAutoLaunch: (enable) => ipcRenderer.invoke('set-auto-launch', enable),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setWindowViewMode: (mode, savedBounds) => ipcRenderer.invoke('set-window-view-mode', mode, savedBounds),
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
  snapCompactWindow: (edge) => ipcRenderer.invoke('snap-compact-window', edge),
  setCompactSizePreset: (preset) => ipcRenderer.invoke('set-compact-size-preset', preset),
  backupDatabase: () => ipcRenderer.invoke('backup-database'),
  backupChatHistory: () => ipcRenderer.invoke('backup-chat-history'),
  clearAllChatHistory: () => ipcRenderer.invoke('clear-all-chat-history'),
  recoverCorruptDatabase: () => ipcRenderer.invoke('recover-corrupt-database'),
  applyRecoveredDatabase: (recoveredPath) => ipcRenderer.invoke('apply-recovered-database', recoveredPath),
  listRecoverableBackups: () => ipcRenderer.invoke('list-recoverable-backups'),
  restoreFromBackup: (backupPath) => ipcRenderer.invoke('restore-from-backup', backupPath),
  getNotificationPreviewSetting: () => ipcRenderer.invoke('get-notification-preview-setting'),
  setNotificationPreviewSetting: (enabled) => ipcRenderer.invoke('set-notification-preview-setting', enabled),
  getMessageNotificationSettings: () => ipcRenderer.invoke('get-message-notification-settings'),
  setMessageNotificationSettings: (settings) => ipcRenderer.invoke('set-message-notification-settings', settings),
  getSpellcheckEnabled: () => ipcRenderer.invoke('get-spellcheck-enabled'),
  setSpellcheckEnabled: (enabled) => ipcRenderer.invoke('set-spellcheck-enabled', enabled),

  // 📶 네트워크 상태 진단
  getNetworkStatus: () => ipcRenderer.invoke('get-network-status'),
  onNetworkStatusUpdate: (callback) => ipcRenderer.on('network-status-update', (e, data) => callback(data)),

  // 🔄 쉬운 업데이트
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getInstallPathInfo: () => ipcRenderer.invoke('get-install-path-info'),
  onInstallPathWarning: (callback) => ipcRenderer.on('install-path-warning', (e, data) => callback(data)),
  mirrorUpdateToZBridge: () => ipcRenderer.invoke('mirror-update-to-z-bridge'),
  getUpdateSourcePath: () => ipcRenderer.invoke('get-update-source-path'),
  setUpdateSourcePath: (folderPath) => ipcRenderer.invoke('set-update-source-path', folderPath),
  getUpdateMode: () => ipcRenderer.invoke('get-update-mode'),
  setUpdateMode: (mode) => ipcRenderer.invoke('set-update-mode', mode),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  onAutoUpdateReady: (callback) => ipcRenderer.on('auto-update-ready', (e, data) => callback(data)),
  onAutoUpdateStarted: (callback) => ipcRenderer.on('auto-update-started', (e, data) => callback(data)),
  onAppUpdateProgress: (callback) => ipcRenderer.on('app-update-progress', (e, data) => callback(data)),
  onOpenChatFromToast: (callback) => ipcRenderer.on('open-chat-from-toast', (e, data) => callback(data)),
  onAutoUpdateFailed: (callback) => ipcRenderer.on('auto-update-failed', (e, data) => callback(data)),
  restartNowForUpdate: () => ipcRenderer.invoke('restart-now-for-update'),
  snoozePendingRestart: (minutes) => ipcRenderer.invoke('snooze-pending-restart', minutes),

  // 🔄 유저 새로고침 및 폴더 열기
  refreshUsers: () => ipcRenderer.invoke('refresh-users'),
  openUserDataFolder: () => ipcRenderer.invoke('open-user-data-folder'),
  openFilesFolder: () => ipcRenderer.invoke('open-files-folder'),
  getDownloadFolder: () => ipcRenderer.invoke('get-download-folder'),
  chooseDownloadFolder: () => ipcRenderer.invoke('choose-download-folder'),
  saveChatFileAttachment: (payload) => ipcRenderer.invoke('save-chat-file-attachment', payload),

  // 📡 실시간 이벤트 리스너
  onUserListUpdate: (callback) => ipcRenderer.on('user-list-update', (e, users) => callback(users)),
  onProfilePhotoUpdate: (callback) => ipcRenderer.on('profile-photo-update', (e, data) => callback(data)),
  onReceiveMessage: (callback) => ipcRenderer.on('receive-message', (e, msg) => callback(msg)),
  onReceiveBroadcast: (callback) => ipcRenderer.on('receive-broadcast', (e, msg) => callback(msg)),
  onReceiveDeptMessage: (callback) => ipcRenderer.on('receive-dept-message', (e, msg) => callback(msg)),
  onReceiveFloorMessage: (callback) => ipcRenderer.on('receive-floor-message', (e, msg) => callback(msg)),
  onReceiveGroupMessage: (callback) => ipcRenderer.on('receive-group-message', (e, msg) => callback(msg)),
  onGroupChatsUpdate: (callback) => ipcRenderer.on('group-chats-update', (e) => callback()),
  onReadReceipt: (callback) => ipcRenderer.on('read-receipt', (e, data) => callback(data)),
  onNoticesUpdate: (callback) => ipcRenderer.on('notices-update', (e) => callback()),
  onNoticeOperatorsUpdate: (callback) => ipcRenderer.on('notice-operators-update', (e) => callback()),
  onSchedulesUpdate: (callback) => {
    let debounceTimer = null;
    ipcRenderer.on('schedules-update', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        try { callback(); } catch (err) { console.error('onSchedulesUpdate', err); }
      }, 100);
    });
  },
  onScheduledMessageSent: (callback) => ipcRenderer.on('scheduled-message-sent', (e, data) => callback(data)),
  onPendingStatusUpdate: (callback) => ipcRenderer.on('pending-status-update', (e, data) => callback(data)),
  onTriggerOpenAllLogs: (callback) => ipcRenderer.on('trigger-open-all-logs', () => callback()),
  onTriggerOpenSettings: (callback) => ipcRenderer.on('trigger-open-settings', () => callback()),
  onMainProcessLog: (callback) => ipcRenderer.on('main-process-log', (e, data) => callback(data)),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximizeToggle: () => ipcRenderer.invoke('window-maximize-toggle'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  focusMainWindow: () => ipcRenderer.invoke('focus-main-window'),
  pushToastUiState: (state) => ipcRenderer.send('toast-ui-state', state),
  getDesktopCaptureSources: () => ipcRenderer.invoke('get-desktop-capture-sources'),
  captureDesktopSourceImage: (sourceId) => ipcRenderer.invoke('capture-desktop-source-image', sourceId),
  setMainWindowHidden: (hidden) => ipcRenderer.invoke('set-main-window-hidden', hidden),
  setTrayLaunchViewMode: (mode) => ipcRenderer.invoke('set-tray-launch-view-mode', mode),
  getTrayLaunchViewMode: () => ipcRenderer.invoke('get-tray-launch-view-mode'),
  onApplyTrayViewMode: (callback) => ipcRenderer.on('apply-tray-view-mode', (e, mode) => callback(mode)),
  onTrayLaunchViewModeChanged: (callback) => ipcRenderer.on('tray-launch-view-mode-changed', (e, mode) => callback(mode)),
  onWindowMaximizedState: (callback) => ipcRenderer.on('window-maximized-state', (e, isMax) => callback(isMax)),
  onMainWindowHidden: (callback) => ipcRenderer.on('main-window-hidden', () => callback())
});