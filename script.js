/**
 * Media Cycler Extension for SillyTavern
 * Version 1.0 (Made with Love and Vibe Coding, please no hate)
 * @author Goomba
 */

(function() {
    'use strict';
    
    // Check if debug is enabled in settings (for initial load message only)
    try {
        const savedSettings = localStorage.getItem('mediaCycler_settings');
        if (savedSettings) {
            const settings = JSON.parse(savedSettings);
            if (settings.debugEnabled) {
                console.log('🔧 Media Cycler: Script file loaded!');
            }
        }
    } catch (e) {
        // Ignore errors reading settings
    }

    // Extension metadata
    const EXTENSION_NAME = 'Media Cycler';
    const EXTENSION_VERSION = '1.0.0';
    
    const CONFIG = {
        DISPLAY_DURATION: 10000, // Default 10 seconds (minimum enforced: 2 seconds)
        FADE_DURATION: 1000, // Fixed fade duration (not user-configurable)
        BASE_PATH: '/backgrounds/media/',
        STORAGE_KEYS: {
            FILES: 'mediaCycler_files',
            POSITION: 'mediaCycler_position',
            SHUFFLE: 'mediaCycler_shuffle',
            SETTINGS: 'mediaCycler_settings',
            USE_DEFAULTS_FLAG: 'mediaCycler_useDefaults' // Flag to revert to defaults on next load
        },
        INDEXEDDB_NAME: 'MediaCyclerDB',
        INDEXEDDB_VERSION: 2, // Incremented to add blob store
        INDEXEDDB_STORE: 'fileHandles',
        INDEXEDDB_BLOB_STORE: 'fileBlobs' // Store for File/Blob objects (fallback method)
    };

    class MediaCycler {
        constructor() {
            this.state = {
                isEnabled: true,
                currentIndex: 0,
                currentMedia: null,
                nextMedia: null,
                currentMediaWrapper: null,
                nextMediaWrapper: null,
                cycleTimeout: null,
                fadeTimeout: null,
                mediaStartTime: null, // Timestamp when current media started playing
                mediaFiles: [], // Now stores File objects
                objectURLs: new Map(), // Maps File objects to their object URLs
                isMovableMode: false,
                isShuffleMode: false,
		shuffledIndices: null,
                shuffleIndex: 0,
		isUIVisible: false,
		isAudioUnlocked: false,
		isAudioEnabled: false, // Start muted
		isTransitioning: false,
		lastNextAt: 0,
		lastPrevAt: 0,
		volume: 0.8,
                isMediaVisible: false,
                imageDuration: 10000, // Default 10 seconds for images
                videoMinDuration: 8000,  // Min seconds to show (loop short clips until this)
                videoMaxDuration: 15000, // Max seconds (cap long clips at this)
                playVideoUntilEnd: false, // Play videos until they end naturally
                validationStatus: null, // Stores validation results: { loaded: number, removed: number }
                validationProgress: null, // Tracks batch processing progress: { total: number, completed: number, failed: number, currentFile: string|null }
                storageCapacity: null, // Storage capacity info: { quota: number, usage: number, percentage: number, ourUsage: number, totalUsage: number }
                statusScrollAnimation: null, // Reference to ongoing scroll animation timeout
                videoPlayStartTime: null, // Track when video started playing for minimum duration check
                videoMinDurationTimeout: null, // Timeout for minimum 2-second video duration
                isCharacterSpecificMode: false, // Character-specific media lists enabled
                fallbackToHome: true, // Fallback to home list when character has no media
                currentCharacterId: null, // Current character ID
                currentCharacterName: null, // Current character name
                characterLists: new Map(), // Map of characterId -> { name, files: [], metadata: [] }
                activeListType: 'home', // 'home' or 'character'
                pendingFileSelection: null, // { listType: 'home'|'character', characterId: string|null } for fallback file input
                debugEnabled: false, // Debug logging toggle (default: off)
                isBackgroundMode: false, // Background mode (fullscreen media)
                previousContainerState: null // { left, top, width, height } - saved state before background mode
            };

	    this.elements = {};
            this.isInitialized = false;
            this.db = null; // IndexedDB database instance
            this.stContext = null; // SillyTavern extension context
            this.intervals = []; // Track intervals for cleanup
            this.observers = []; // Track observers for cleanup
            
            // Bind methods to maintain context
            this.handleFileSelection = this.handleFileSelection.bind(this);
            this.handleFileSystemSelection = this.handleFileSystemSelection.bind(this);
            this.togglePlayPause = this.togglePlayPause.bind(this);
            this.handleNextMedia = this.handleNextMedia.bind(this);
            this.handlePrevMedia = this.handlePrevMedia.bind(this);
            this.toggleMovableMode = this.toggleMovableMode.bind(this);
            this.toggleShuffleMode = this.toggleShuffleMode.bind(this);
        }
		
	setupAutoplayUnlock() {
            const unlockAudio = () => {
                if (this.state.isAudioUnlocked) return;
                
                this.debugLog('🎵 Unlocking audio for session...');
                this.state.isAudioUnlocked = true;
                this.showStatusMessage('Audio enabled. Videos will play with sound enabled on next video.');
                
                // Create and play/pause a silent audio to unlock autoplay
                const silentAudio = new Audio();
                silentAudio.src = 'data:audio/wav;base64,UklGRnoAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoAAAC';
                silentAudio.volume = 0.001;
                
                silentAudio.play().then(() => {
                    silentAudio.pause();
                    this.debugLog('✅ Audio autoplay unlocked!');
                    const current = this.state.currentMedia;
                    if (current && current.tagName === 'VIDEO') {
                        try {
                            current.muted = false;
                            current.volume = this.state.volume;
                            current.play().catch(() => {});
                        } catch (e) {}
                    }
                }).catch(error => {
                    this.debugWarn('⚠️ Audio unlock failed:', error);
                });
                
                // Remove event listeners after first successful unlock
                document.removeEventListener('click', unlockAudio);
                document.removeEventListener('keydown', unlockAudio);
                document.removeEventListener('touchstart', unlockAudio);
            };
            
            // Listen for any user interaction
            document.addEventListener('click', unlockAudio, { once: true });
            document.addEventListener('keydown', unlockAudio, { once: true });
            document.addEventListener('touchstart', unlockAudio, { once: true });
            
            this.debugLog('🎵 Audio unlock listeners active - click anywhere to enable sound');
        }

        async initialize() {
            if (this.isInitialized) {
                this.debugWarn(`${EXTENSION_NAME} already initialized`);
                return;
            }

            try {
                this.debugLog(`🎬 ${EXTENSION_NAME} v${EXTENSION_VERSION}: Initializing...`);
                
                // Quick check for extension_manager (500ms max wait)
                await this.waitForExtensionManager();
                
                // Wait for DOM to be ready (should be instant if already loaded)
                    await this.waitForSTReady();
                
                // Load settings first (state values only, positions loaded after UI exists)
                this.loadAllSettings();
                this.createUIElements();
                // Sync shuffle button visual state with saved setting
                if (typeof this.updateShuffleUI === 'function') {
                    this.updateShuffleUI();
                }
                // Now load positions since UI elements exist
                this.loadUIPositions();
                await this.initIndexedDB();
                await this.loadCharacterLists();
                await this.loadSavedData();
                await this.checkStorageCapacity();
                this.setupEventListeners();
                this.setupThemeSync();
                this.updateUIState();
                await this.loadSettingsHTML();
                this.initializeSettingsUI();
                this.updateHomeListStatus();
                // Set default positions only if not loaded from saved settings
                if (!this.elements.container?.style.left && !this.elements.circleContainer?.style.left) {
                    this.setDefaultPositions();
                }
                // Ensure minimal UI is visible after all position setup (controls should be hidden on startup)
                if (this.elements.minimalUI && !this.state.isUIVisible) {
                    this.elements.minimalUI.style.display = 'block';
                    this.updateEyeButtons();
                }
                this.updateCharacterModeUI();
                this.updateListIndicators();
                // Register with ST and detect character BEFORE determining active list
                // This ensures correct list selection if character is already in chat on page load
                this.registerWithST();
                // Wait a brief moment for character detection to complete
                await new Promise(resolve => setTimeout(resolve, 100));
                // After loading all data and detecting character, determine which list should be active
                await this.updateActiveList();
                // Update character-specific mode toggle and fallback toggle state after UI is created
                if (this.elements.charModeToggle) {
                    if (this.state.isCharacterSpecificMode) {
                        this.elements.charModeToggle.classList.add('toggle-active');
                    } else {
                        this.elements.charModeToggle.classList.remove('toggle-active');
                    }
                }
                if (this.elements.fallbackRow) {
                    this.elements.fallbackRow.style.display = this.state.isCharacterSpecificMode ? 'flex' : 'none';
                }
                if (this.elements.fallbackToggle) {
                    this.elements.fallbackToggle.disabled = !this.state.isCharacterSpecificMode;
                    if (this.state.fallbackToHome) {
                        this.elements.fallbackToggle.classList.add('toggle-active');
                    } else {
                        this.elements.fallbackToggle.classList.remove('toggle-active');
                    }
                }
                // Update playVideoUntilEnd toggle after settings are loaded
                if (this.elements.playVideoUntilEndToggle) {
                    if (this.state.playVideoUntilEnd) {
                        this.elements.playVideoUntilEndToggle.classList.add('toggle-active');
                        this.elements.playVideoUntilEndToggle.setAttribute('title', 'Play video until it ends (minimum 2 seconds, loops if shorter)');
                    } else {
                        this.elements.playVideoUntilEndToggle.classList.remove('toggle-active');
                        this.elements.playVideoUntilEndToggle.setAttribute('title', 'Play video until it ends instead of using duration (minimum 2 seconds, loops if shorter)');
                    }
                    // Also update video duration input disabled state
                    if (this.elements.videoMinDurationInput) {
                        this.elements.videoMinDurationInput.disabled = this.state.playVideoUntilEnd;
                        this.elements.videoMinDurationInput.style.opacity = this.state.playVideoUntilEnd ? '0.5' : '1';
                    }
                    if (this.elements.videoMaxDurationInput) {
                        this.elements.videoMaxDurationInput.disabled = this.state.playVideoUntilEnd;
                        this.elements.videoMaxDurationInput.style.opacity = this.state.playVideoUntilEnd ? '0.5' : '1';
                    }
                }
                // Update volume input value and display after settings are loaded
                if (this.elements.volumeInput && this.elements.volumeValueDisplay) {
                    this.elements.volumeInput.value = this.state.volume;
                    this.elements.volumeValueDisplay.textContent = parseFloat(this.elements.volumeInput.value).toFixed(1);
                }
                // Also sync quick actions volume slider
                if (this.elements.volumeQuickInput) {
                    this.elements.volumeQuickInput.value = this.state.volume;
                    // Update icon based on muted state (start muted)
                    this.updateVolumeIcon(this.state.isAudioEnabled ? this.state.volume : 0);
                }
                
                if (this.state.mediaFiles.length > 0) {
                    // Don't start cycling automatically - wait for user to press play
                    // But update status to show validation results
                    this.updateStatusDisplay();
                    this.debugLog(`✅ ${EXTENSION_NAME}: Ready with ${this.state.mediaFiles.length} media files`);
                } else {
                    this.showStatusMessage('Click "Select Files" to choose media');
                }
                
                this.isInitialized = true;
                // registerWithST() already called above before updateActiveList()
                
            } catch (error) {
                this.debugError(`❌ ${EXTENSION_NAME} initialization failed:`, error);
            }
        }

        waitForExtensionManager() {
            return new Promise((resolve) => {
                // Quick check - if extension_manager is already available, use it immediately
                if (typeof extension_manager !== 'undefined') {
                    resolve();
                    return;
                }
                
                // Otherwise, wait just 500ms in case it appears (unlikely but possible)
                // This is much faster than the old 10 second wait
                let attempts = 0;
                const maxAttempts = 5; // 500ms (5 * 100ms)
                const checkInterval = setInterval(() => {
                    attempts++;
                    if (typeof extension_manager !== 'undefined') {
                        clearInterval(checkInterval);
                        resolve();
                    } else if (attempts >= maxAttempts) {
                        clearInterval(checkInterval);
                        resolve(); // Continue anyway - we use DOM detection
                    }
                }, 100);
            });
        }

        waitForSTReady() {
            return new Promise((resolve) => {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', resolve);
                } else {
                    resolve();
                }
            });
        }

        registerWithST() {
            this.debugLog('🔧 Media Cycler: registerWithST() called');
            this.debugLog('🔧 Media Cycler: extension_manager type:', typeof extension_manager);
            
            // Register with SillyTavern extension system if available
            if (typeof extension_manager !== 'undefined') {
                this.debugLog('🔧 Media Cycler: extension_manager exists, attempting registration...');
                try {
                    extension_manager.registerExtension(EXTENSION_NAME, {
                        version: EXTENSION_VERSION,
                        onChatChanged: () => this.handleChatChange(),
                        onCharacterSelected: () => this.handleCharacterChange()
                    });
                    this.debugLog(`✅ ${EXTENSION_NAME}: Registered with ST extension system`);
                    
                    // Try to get ST extension context for storage
                    try {
                        if (typeof extension_manager.getContext === 'function') {
                            this.stContext = extension_manager.getContext(EXTENSION_NAME);
                            this.debugLog(`✅ ${EXTENSION_NAME}: Got ST extension context`);
                        } else {
                            this.debugLog('⚠️ Media Cycler: extension_manager.getContext is not a function');
                        }
                    } catch (e) {
                        this.debugWarn(`⚠️ ${EXTENSION_NAME}: Could not get ST context:`, e);
                    }
                    
                    // Try to detect current character (silent on init)
                    this.detectCurrentCharacter(true).catch(() => {});
                } catch (error) {
                    this.debugError(`❌ ${EXTENSION_NAME}: Could not register with ST extension system:`, error);
                }
            } else {
                this.debugWarn('⚠️ Media Cycler: extension_manager is not defined! Extension may not be loading correctly.');
                // Still try to detect character even without extension_manager (silent)
                this.detectCurrentCharacter(true).catch(() => {});
            }
        }

        async detectCurrentCharacter(silent = false) {
            try {
                let detected = false;
                const oldCharacterId = this.state.currentCharacterId;
                const oldCharacterName = this.state.currentCharacterName;
                
                // DOM-based detection (only method that works)
                try {
                    const rejectValues = [
                        'None', 'Select Character', 'Character', 'Default', 
                        'default', 'DEFAULT', 'No Character', 'No character',
                        'Select a character', 'Choose character', 'Character Name',
                        'names_display', 'character_name', 'name'
                    ];
                    
                    // Try specific selectors first, then broader search
                    const selectors = [
                        'h2:not([id*="display"]):not([class*="display"])',
                        'h1:not([id*="display"]):not([class*="display"])',
                        '#character_name',
                        '.character_name',
                        '[data-character-name]'
                    ];
                    
                    for (const selector of selectors) {
                        try {
                            const elements = document.querySelectorAll(selector);
                            for (const element of elements) {
                                const name = element.textContent?.trim() || element.innerText?.trim();
                                if (name && name.length > 2 && name.length < 100 && !rejectValues.includes(name)) {
                                    if (name.includes(':') || name.toLowerCase().includes('character name')) continue;
                                    
                                    this.state.currentCharacterName = name;
                                    this.state.currentCharacterId = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
                                    detected = true;
                                    break;
                                }
                            }
                            if (detected) break;
                        } catch (e) {
                            // Continue
                        }
                    }
                } catch (e) {
                    // Silent fail
                }
                
                if (!detected) {
                    this.state.currentCharacterId = null;
                    this.state.currentCharacterName = null;
                    return false;
                }
                
                // Update UI if character actually changed (silent only affects console logging)
                const changed = oldCharacterId !== this.state.currentCharacterId || oldCharacterName !== this.state.currentCharacterName;
                if (changed) {
                    // Update character name indicator first
                    this.updateListIndicators();
                    
                    // If character was lost and character-specific mode is on without fallback, stop playback
                    if (!this.state.currentCharacterId && this.state.isCharacterSpecificMode && !this.state.fallbackToHome) {
                        if (this.state.isEnabled) {
                            this.state.isEnabled = false;
                            this.stopMediaCycling();
                            if (this.elements.toggleBtn) {
                                this.updatePlayPauseIcon();
                            }
                        }
                        if (this.state.activeListType === 'character') {
                            this.state.mediaFiles = [];
                            this.state.currentIndex = 0;
                            this.cleanupObjectURLs();
                        }
                    }
                    
                    // Update active list based on character-specific mode
                    await this.updateActiveList();
                    // Update UI if character list is visible (updateActiveList already calls updateCharacterListUI)
                    if (this.elements.charListContainer) {
                        this.updateCharacterListUI();
                    }
                }
                
                return detected;
            } catch (e) {
                this.state.currentCharacterId = null;
                this.state.currentCharacterName = null;
                return false;
            }
        }

        async handleCharacterChange() {
            await this.detectCurrentCharacter();
        }
        
        async updateActiveList() {
            // Store if Home was playing before switching
            const wasHomePlaying = this.state.isEnabled && this.state.activeListType === 'home';
            // Store if any list was playing (home or character) - needed for character-to-character switching
            const wasPlaying = this.state.isEnabled;
            
            // Determine which list should be active based on character-specific mode and fallback
            if (this.state.isCharacterSpecificMode) {
                // Character-specific mode is enabled
                if (this.state.currentCharacterId) {
                    // Character is detected - check if character has a list with files
                    const charList = this.state.characterLists.get(this.state.currentCharacterId);
                    if (charList && charList.metadata && charList.metadata.length > 0) {
                        // Character has media - use character list
                        // Preserve playback if any list was playing (home or character)
                        await this.switchToCharacterList(this.state.currentCharacterId, wasPlaying);
                    } else if (this.state.fallbackToHome) {
                        // No character media but fallback enabled - use home list
                        await this.switchToHomeList();
                    } else {
                        // No character media and no fallback - show empty and stop playback
                        if (this.state.isEnabled) {
                            this.state.isEnabled = false;
                            this.stopAndClearMedia();
                            if (this.elements.toggleBtn) {
                                this.updatePlayPauseIcon();
                            }
                        }
                        this.state.mediaFiles = [];
                        this.state.currentIndex = 0;
                        this.state.activeListType = 'character';
                        this.cleanupObjectURLs();
                        this.updateUIState();
                        this.updateFileCountDisplay();
                        this.updateListIndicators();
                    }
                } else {
                    // No character detected - switch to character mode anyway (no fallback means stop main)
                    if (!this.state.fallbackToHome) {
                        // No fallback - stop Home playback and show empty
                        // If character was playing, stop it
                        if (this.state.isEnabled) {
                            this.state.isEnabled = false;
                            this.stopAndClearMedia();
                            if (this.elements.toggleBtn) {
                                this.updatePlayPauseIcon();
                            }
                        }
                        // If Home was active, clear it
                        if (this.state.activeListType === 'home') {
                            this.state.mediaFiles = [];
                            this.state.currentIndex = 0;
                            this.cleanupObjectURLs();
                        }
                        this.state.activeListType = 'character';
                        this.updateUIState();
                        this.updateFileCountDisplay();
                        this.updateListIndicators();
                    } else {
                        // Fallback enabled - use home list even without character
                        // If character was playing, preserve playback state when switching to home
                        const wasCharacterPlaying = this.state.isEnabled && this.state.activeListType === 'character';
                        await this.switchToHomeList();
                        // If character was playing and home has files, continue playing
                        if (wasCharacterPlaying && this.state.mediaFiles.length > 0 && !this.state.isEnabled) {
                            this.state.isEnabled = true;
                            this.startMediaCycling();
                            if (this.elements.toggleBtn) {
                                this.updatePlayPauseIcon();
                                this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn playing';
                            }
                            if (!this.state.isMediaVisible) {
                                this.state.isMediaVisible = true;
                                this.syncMediaVisibilityUI();
                            }
                        }
                    }
                }
            } else {
                // Character-specific mode off - use home list
                if (this.state.activeListType !== 'home') {
                    await this.switchToHomeList();
                }
            }
        }

        async switchToCharacterList(characterId, preservePlayback = false) {
            if (!this.state.characterLists.has(characterId)) {
                // Character has no list
                if (this.state.fallbackToHome) {
                    // Fallback to home list - preserve playback if character was playing
                    const wasCharacterPlaying = this.state.isEnabled && this.state.activeListType === 'character';
                    this.switchToHomeList();
                    // If character was playing and home has files, continue playing
                    if (wasCharacterPlaying && this.state.mediaFiles.length > 0 && !this.state.isEnabled) {
                        this.state.isEnabled = true;
                        this.startMediaCycling();
                        if (this.elements.toggleBtn) {
                            this.updatePlayPauseIcon();
                        }
                        if (!this.state.isMediaVisible) {
                            this.state.isMediaVisible = true;
                            this.syncMediaVisibilityUI();
                        }
                    }
                    this.showStatusMessage(`No media for ${this.state.currentCharacterName || 'this character'} - using home list`);
                } else {
                    // Show empty and stop playback
                    if (this.state.isEnabled) {
                        this.state.isEnabled = false;
                        this.stopAndClearMedia();
                        if (this.elements.toggleBtn) {
                            this.updatePlayPauseIcon();
                            this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn paused';
                        }
                    }
                    this.state.mediaFiles = [];
                    this.state.currentIndex = 0;
                    this.state.activeListType = 'character';
                    this.cleanupObjectURLs();
                    this.updateUIState();
                    this.showStatusMessage(`No media list for ${this.state.currentCharacterName || 'this character'}`);
                }
                return;
            }
            
            // Store if we should preserve playback state (either from Home or character)
            const wasPlaying = this.state.isEnabled;
            const shouldPlay = preservePlayback && wasPlaying;
            
            // Stop and clear current media before switching
            this.stopAndClearMedia();
            
            const charList = this.state.characterLists.get(characterId);
            // Load character's media files
            await this.loadCharacterMediaList(characterId);
            
            // Reset index to 0 for fresh start (or could preserve if same file exists)
            this.state.currentIndex = 0;
            if (this.state.isShuffleMode && this.state.mediaFiles.length > 0) {
                this.reshuffleIndices();
                this.state.currentIndex = this.state.shuffledIndices?.[0] ?? 0;
            }
            
            // If we were playing (Home or character) and character has files, continue playing
            if (shouldPlay && this.state.mediaFiles.length > 0) {
                this.state.isEnabled = true;
                this.startMediaCycling();
                if (this.elements.toggleBtn) {
                    this.updatePlayPauseIcon();
                }
                // Ensure media is visible
                if (!this.state.isMediaVisible) {
                    this.state.isMediaVisible = true;
                    this.syncMediaVisibilityUI();
                }
            } else if (wasPlaying && this.state.mediaFiles.length === 0) {
                // Was playing but character has no files - stop playback
                this.state.isEnabled = false;
                if (this.elements.toggleBtn) {
                    this.updatePlayPauseIcon();
                    this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn paused';
                }
            }
            
            // Update active list state
            this.state.activeListType = 'character';
            this.state.currentCharacterId = characterId;
            
            // Update character list UI to show the character's section
            this.updateCharacterListUI();
        }

        async switchToHomeList() {
            // Check if home list is allowed (not when character-specific mode is on without fallback)
            if (this.state.isCharacterSpecificMode && !this.state.fallbackToHome) {
                // Home list not allowed - stop playback if it was playing
                if (this.state.isEnabled && this.state.activeListType === 'home') {
                    this.state.isEnabled = false;
                    this.stopAndClearMedia();
                    if (this.elements.toggleBtn) {
                        this.updatePlayPauseIcon();
                        this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn paused';
                    }
                }
                // Clear home media if it was active
                if (this.state.activeListType === 'home') {
                    this.state.mediaFiles = [];
                    this.state.currentIndex = 0;
                    this.cleanupObjectURLs();
                    this.updateUIState();
                    this.updateFileCountDisplay();
                }
                return; // Don't switch to home
            }
            
            // Store if we were playing (either home or character)
            const wasPlaying = this.state.isEnabled;
            const wasHomeActive = this.state.activeListType === 'home';
            
            // Stop and clear current media before switching
            this.stopAndClearMedia();
            
            this.state.activeListType = 'home';
            // Don't clear currentCharacterId when fallback is ON - preserve it so we can still show
            // the character folder and allow linking/refreshing even when using home list
            if (!this.state.fallbackToHome) {
                this.state.currentCharacterId = null;
            }
            
            // Reload home list
            await this.loadSavedFileList();
            this.updateFileCountDisplay();
            this.updateUIState();
            this.updateListIndicators();
            
            // Reset index to 0 for fresh start (or could preserve if same file exists)
            this.state.currentIndex = 0;
            if (this.state.isShuffleMode && this.state.mediaFiles.length > 0) {
                this.reshuffleIndices();
                this.state.currentIndex = this.state.shuffledIndices?.[0] ?? 0;
            }
            
            // If it was playing before (home or character), resume playback on home if it has files
            if (wasPlaying && this.state.mediaFiles.length > 0) {
                this.state.isEnabled = true;
                this.startMediaCycling();
                if (this.elements.toggleBtn) {
                    this.updatePlayPauseIcon();
                    this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn playing';
                }
                // Ensure media is visible
                if (!this.state.isMediaVisible) {
                    this.state.isMediaVisible = true;
                    this.syncMediaVisibilityUI();
                }
            } else if (wasPlaying && this.state.mediaFiles.length === 0) {
                // Was playing but Home has no files - stop playback
                this.state.isEnabled = false;
                if (this.elements.toggleBtn) {
                    this.updatePlayPauseIcon();
                    this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn paused';
                }
            }
        }

        updateListIndicators() {
            // Update active list indicator above tabs
            if (this.elements.activeListIndicator) {
                if (this.state.activeListType === 'character' && this.state.currentCharacterName) {
                    this.elements.activeListIndicator.textContent = `Active: ${this.state.currentCharacterName}`;
                } else if (this.state.isCharacterSpecificMode && !this.state.fallbackToHome && 
                          (!this.state.currentCharacterId || 
                           (this.state.activeListType === 'character' && this.state.mediaFiles.length === 0))) {
                    // Character-specific mode on, no fallback, and no active character/media
                    this.elements.activeListIndicator.textContent = 'Active: None';
                } else {
                    this.elements.activeListIndicator.textContent = 'Active: Home';
                }
            }
            
            // Update character name indicator (always shows detected character, even when Home is active)
            if (this.elements.characterNameIndicator) {
                if (this.state.currentCharacterName) {
                    this.elements.characterNameIndicator.textContent = this.state.currentCharacterName;
                } else {
                    this.elements.characterNameIndicator.textContent = 'No character';
                }
            }
        }

        updateCharacterModeUI() {
            // Update toggle button states
            if (this.elements.charModeToggle) {
                if (this.state.isCharacterSpecificMode) {
                    this.elements.charModeToggle.classList.add('toggle-active');
                } else {
                    this.elements.charModeToggle.classList.remove('toggle-active');
                }
            }
            // Refresh button visibility is handled in updateCharacterListUI
            if (this.elements.fallbackToggle) {
                if (this.state.fallbackToHome) {
                    this.elements.fallbackToggle.classList.add('toggle-active');
                } else {
                    this.elements.fallbackToggle.classList.remove('toggle-active');
                }
            }
            
            // Grey out Home tab when character-specific mode is on AND fallback is disabled
            if (this.elements.mainTab) {
                if (this.state.isCharacterSpecificMode && !this.state.fallbackToHome) {
                    this.elements.mainTab.style.opacity = '0.5';
                    this.elements.mainTab.style.pointerEvents = 'none';
                    this.elements.mainTab.setAttribute('title', 'Disabled in character-specific mode (fallback disabled)');
                } else {
                    this.elements.mainTab.style.opacity = '1';
                    this.elements.mainTab.style.pointerEvents = 'auto';
                    this.elements.mainTab.removeAttribute('title');
                }
            }
            this.updateListIndicators();
        }

        updateCharacterListUI() {
            if (!this.elements.charListContainer) return;
            
            this.elements.charListContainer.innerHTML = '';
            
            // Show/hide Link button and move Refresh button based on whether character has a list
            // Note: fallbackToHome setting does NOT affect button visibility - buttons should always show
            // when character-specific mode is on and a character is detected
            if (this.elements.charButtonRow && this.elements.refreshRow) {
                const hasCharacterList = this.state.currentCharacterId && 
                                        this.state.characterLists.has(this.state.currentCharacterId);
                
                // Hide button row entirely only if character-specific mode is off
                // When character-specific mode is on, always show buttons (even if no character detected yet)
                // This allows users to link/refresh characters even when fallback is using home list
                if (!this.state.isCharacterSpecificMode) {
                    this.elements.charButtonRow.style.display = 'none';
                    this.elements.refreshRow.style.display = 'none';
                } else {
                    // Character-specific mode is on - show buttons regardless of fallbackToHome or currentCharacterId
                    // If character is detected, show appropriate buttons based on whether it has a list
                    if (this.state.currentCharacterId) {
                        // Character is detected - show buttons based on whether it has a list
                        if (this.elements.linkCharBtn) {
                            this.elements.linkCharBtn.style.display = hasCharacterList ? 'none' : 'inline-block';
                        }
                        
                        // Move refresh button between buttonRow and refreshRow based on folder existence
                        if (this.elements.refreshCharBtn) {
                            if (hasCharacterList) {
                                // Move refresh button to refreshRow below character folder
                                // Style it like Char Mode/Fallback buttons
                                this.elements.refreshCharBtn.style.width = '100%';
                                this.elements.refreshCharBtn.style.padding = '8px 12px';
                                this.elements.refreshCharBtn.style.fontSize = '12px';
                                this.elements.refreshCharBtn.style.borderRadius = '6px';
                                this.elements.refreshCharBtn.style.display = 'block';
                                // Move button to refreshRow if not already there
                                if (this.elements.refreshCharBtn.parentElement !== this.elements.refreshRow) {
                                    this.elements.refreshRow.appendChild(this.elements.refreshCharBtn);
                                }
                                this.elements.refreshRow.style.display = 'flex';
                            } else {
                                // Move refresh button back to buttonRow beside Link button
                                // Reset to compact style
                                this.elements.refreshCharBtn.style.width = 'auto';
                                this.elements.refreshCharBtn.style.padding = '';
                                this.elements.refreshCharBtn.style.fontSize = '';
                                this.elements.refreshCharBtn.style.borderRadius = '';
                                this.elements.refreshCharBtn.style.display = 'inline-block';
                                // Move button to buttonRow if not already there
                                if (this.elements.refreshCharBtn.parentElement !== this.elements.charButtonRow) {
                                    this.elements.charButtonRow.appendChild(this.elements.refreshCharBtn);
                                }
                                this.elements.refreshRow.style.display = 'none';
                            }
                        }
                        // Only show buttonRow if no folder (when folder exists, refresh is in refreshRow)
                        this.elements.charButtonRow.style.display = hasCharacterList ? 'none' : 'flex';
                    } else {
                        // No character detected yet - show both Link and Refresh buttons so user can detect/link
                        if (this.elements.linkCharBtn) {
                            this.elements.linkCharBtn.style.display = 'inline-block';
                        }
                        if (this.elements.refreshCharBtn) {
                            this.elements.refreshCharBtn.style.width = 'auto';
                            this.elements.refreshCharBtn.style.padding = '';
                            this.elements.refreshCharBtn.style.fontSize = '';
                            this.elements.refreshCharBtn.style.borderRadius = '';
                            this.elements.refreshCharBtn.style.display = 'inline-block';
                            // Move button to buttonRow if not already there
                            if (this.elements.refreshCharBtn.parentElement !== this.elements.charButtonRow) {
                                this.elements.charButtonRow.appendChild(this.elements.refreshCharBtn);
                            }
                            this.elements.refreshRow.style.display = 'none';
                        }
                        this.elements.charButtonRow.style.display = 'flex';
                    }
                }
            }
            
            if (!this.state.isCharacterSpecificMode) {
                const info = this.createElement('div', {
                    className: 'media-cycler-info',
                    style: 'padding: 12px; text-align: center; color: var(--text-color, rgba(255,255,255,0.6));'
                });
                info.textContent = 'Enable character-specific lists';
                this.elements.charListContainer.append(info);
                return;
            }
            
            // Check if no character is selected
            if (!this.state.currentCharacterId || !this.state.currentCharacterName) {
                const info = this.createElement('div', {
                    className: 'media-cycler-info',
                    style: 'padding: 12px; text-align: center; color: var(--text-color, rgba(255,255,255,0.6));'
                });
                info.textContent = 'No character selected.';
                this.elements.charListContainer.append(info);
                return;
            }
            
            // Only show current character section if it has a list
            if (this.state.characterLists.has(this.state.currentCharacterId)) {
                const currentCharSection = this.createCharacterSection(
                    this.state.currentCharacterId,
                    this.state.currentCharacterName
                );
                this.elements.charListContainer.append(currentCharSection);
            } else {
                // Show message that character needs to be linked
                const info = this.createElement('div', {
                    className: 'media-cycler-info',
                    style: 'padding: 12px; text-align: center; color: var(--text-color, rgba(255,255,255,0.6));'
                });
                info.textContent = `Press the "Link Character" button to link media for ${this.state.currentCharacterName}`;
                this.elements.charListContainer.append(info);
            }
        }

        createCharacterSection(characterId, characterName) {
            // Character name label on top with ellipsis
            const nameLabel = this.createElement('div', {
                style: 'font-weight: 600; font-size: 13px; margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%;'
            });
            nameLabel.textContent = characterName;
            nameLabel.setAttribute('title', characterName); // Full name on hover
            
            const section = this.createElement('div', {
                className: 'media-cycler-character-section',
                style: 'margin-bottom: 16px; padding: 12px; background: var(--bg-primary, rgba(255,255,255,0.03)); border-radius: 6px; border: 1px solid var(--border-color, rgba(255,255,255,0.1));'
            });
            
            // Button container - positioned nicely
            const buttonContainer = this.createElement('div', {
                style: 'display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-start;'
            });
            
            // Edit Files button
            const addBtn = this.createSTButton('Edit', 'media-cycler-char-add', () => {
                this.handleFileSystemSelection('character', characterId);
            });
            
            // Wipe button
            const clearBtn = this.createSTButton('Wipe', 'media-cycler-char-clear', async () => {
                await this.clearSavedFiles('character', characterId);
            });
            clearBtn.setAttribute('title', `Removes all media files for ${characterName}`);
            
            // Delete Folder button (fully removes the character's list)
            const deleteBtn = this.createSTButton('Delete Folder', 'media-cycler-char-delete', () => {
                if (confirm(`Delete media list for ${characterName}? This will remove the list entirely and the character will use the home list (if fallback is enabled).`)) {
                    this.removeCharacterList(characterId);
                }
            });
            deleteBtn.setAttribute('title', `Fully delete ${characterName}'s media list`);
            
            buttonContainer.append(addBtn, clearBtn, deleteBtn);
            section.append(buttonContainer);
            
            // Create wrapper to hold name label and section
            const wrapper = this.createElement('div', {
                style: 'width: 100%;'
                });
            wrapper.append(nameLabel, section);
            
            return wrapper;
        }

        async linkCurrentCharacter() {
            // If no character detected, try to detect it first
            if (!this.state.currentCharacterId || !this.state.currentCharacterName) {
                const detected = await this.detectCurrentCharacter(false);
                if (!detected) {
                    this.showStatusMessage('No character selected. Please select a character in SillyTavern first.');
                    return;
                }
            }
            
            // Check if character already has a list
            if (this.state.characterLists.has(this.state.currentCharacterId)) {
                // Character already linked - just switch to it
                if (this.state.isCharacterSpecificMode) {
                    this.switchToCharacterList(this.state.currentCharacterId);
                    this.showStatusMessage(`Switched to ${this.state.currentCharacterName}'s media list`);
                } else {
                    // Enable character-specific mode and switch
                    this.state.isCharacterSpecificMode = true;
                    if (this.elements.charModeToggle) {
                        this.elements.charModeToggle.classList.add('toggle-active');
                    }
                    if (this.elements.fallbackRow) {
                        this.elements.fallbackRow.style.display = 'flex';
                    }
                    if (this.elements.fallbackToggle) {
                        this.elements.fallbackToggle.disabled = false;
                    }
                    this.saveSettings();
                    this.updateCharacterModeUI();
                    this.switchToCharacterList(this.state.currentCharacterId);
                    this.showStatusMessage(`Switched to ${this.state.currentCharacterName}'s media list`);
                }
                this.updateCharacterListUI();
                return;
            }
            
            // Create list for current character (doesn't exist yet)
            this.state.characterLists.set(this.state.currentCharacterId, {
                name: this.state.currentCharacterName,
                files: [],
                metadata: []
            });
            this.saveCharacterLists();
            
            // Switch to this character's list and start using it
            if (this.state.isCharacterSpecificMode) {
                this.switchToCharacterList(this.state.currentCharacterId);
            } else {
                // Enable character-specific mode if not already enabled
                this.state.isCharacterSpecificMode = true;
                if (this.elements.charModeToggle) {
                    this.elements.charModeToggle.classList.add('toggle-active');
                }
                if (this.elements.fallbackRow) {
                    this.elements.fallbackRow.style.display = 'flex';
                }
                if (this.elements.fallbackToggle) {
                    this.elements.fallbackToggle.disabled = false;
                }
                this.saveSettings();
                this.updateCharacterModeUI();
                this.switchToCharacterList(this.state.currentCharacterId);
            }
            
            // Update UI to show the character section
            this.updateCharacterListUI();
            this.showStatusMessage(`Created and linked media list for ${this.state.currentCharacterName}`);
        }

        async removeCharacterList(characterId) {
            const charList = this.state.characterLists.get(characterId);
            
            // Clean up object URLs
            if (charList && charList.files) {
                charList.files.forEach(file => {
                    const url = this.state.objectURLs.get(file);
                    if (url) URL.revokeObjectURL(url);
                    this.state.objectURLs.delete(file);
                });
            }
            
            // Remove file handles and blobs from IndexedDB
            if (this.db) {
                try {
                    const prefix = `char_${characterId}_`;
                    
                    // Remove handles
                    const handleTransaction = this.db.transaction([CONFIG.INDEXEDDB_STORE], 'readwrite');
                    const handleStore = handleTransaction.objectStore(CONFIG.INDEXEDDB_STORE);
                    const handleIndex = handleStore.index('prefix');
                    let deletedHandleCount = 0;
                    
                    await new Promise((resolve, reject) => {
                        handleTransaction.oncomplete = () => {
                            if (deletedHandleCount > 0) {
                                this.debugLog(`🗑️ ${EXTENSION_NAME}: Removed ${deletedHandleCount} file handles from IndexedDB for character ${characterId}`);
                            }
                            resolve();
                        };
                        handleTransaction.onerror = () => reject(handleTransaction.error);
                        
                        const handleRequest = handleIndex.openCursor(IDBKeyRange.only(prefix));
                        handleRequest.onsuccess = (event) => {
                            const cursor = event.target.result;
                            if (cursor) {
                                cursor.delete();
                                deletedHandleCount++;
                                cursor.continue();
                            }
                        };
                        handleRequest.onerror = () => reject(handleRequest.error);
                    });
                    
                    // Remove blobs
                    const blobTransaction = this.db.transaction([CONFIG.INDEXEDDB_BLOB_STORE], 'readwrite');
                    const blobStore = blobTransaction.objectStore(CONFIG.INDEXEDDB_BLOB_STORE);
                    const blobIndex = blobStore.index('prefix');
                    let deletedBlobCount = 0;
                    
                    await new Promise((resolve, reject) => {
                        blobTransaction.oncomplete = () => {
                            if (deletedBlobCount > 0) {
                                this.debugLog(`🗑️ ${EXTENSION_NAME}: Removed ${deletedBlobCount} file blobs from IndexedDB for character ${characterId}`);
                            }
                            resolve();
                        };
                        blobTransaction.onerror = () => reject(blobTransaction.error);
                        
                        const blobRequest = blobIndex.openCursor(IDBKeyRange.only(prefix));
                        blobRequest.onsuccess = (event) => {
                            const cursor = event.target.result;
                            if (cursor) {
                                cursor.delete();
                                deletedBlobCount++;
                                cursor.continue();
                            }
                        };
                        blobRequest.onerror = () => reject(blobRequest.error);
                    });
                } catch (e) {
                    this.debugWarn(`⚠️ ${EXTENSION_NAME}: Failed to remove handles/blobs from IndexedDB:`, e);
                }
            }
            
            // Remove metadata from storage
            try {
                // Try ST extensionSettings first
                if (this.stContext && this.stContext.extensionSettings && 
                    this.stContext.extensionSettings[EXTENSION_NAME] &&
                    this.stContext.extensionSettings[EXTENSION_NAME].characterLists) {
                    const listsData = this.stContext.extensionSettings[EXTENSION_NAME].characterLists;
                    if (listsData[characterId]) {
                        delete listsData[characterId];
                        if (typeof this.stContext.saveSettingsDebounced === 'function') {
                            this.stContext.saveSettingsDebounced();
                        }
                    }
                }
                
                // Also remove from localStorage fallback
                const saved = localStorage.getItem(`${CONFIG.STORAGE_KEYS.FILES}_characterLists`);
                if (saved) {
                    const listsData = JSON.parse(saved);
                    if (listsData[characterId]) {
                        delete listsData[characterId];
                        localStorage.setItem(`${CONFIG.STORAGE_KEYS.FILES}_characterLists`, JSON.stringify(listsData));
                    }
                }
            } catch (e) {
                this.debugWarn(`⚠️ ${EXTENSION_NAME}: Failed to remove metadata:`, e);
            }
            
            // Remove from state
            this.state.characterLists.delete(characterId);
            this.saveCharacterLists();
            
            // If this was the active character list, clear media UI like wipe does
            if (this.state.activeListType === 'character' && this.state.currentCharacterId === characterId) {
                // Clear current state and stop playback
                this.state.mediaFiles = [];
                this.state.currentIndex = 0;
                this.cleanupObjectURLs();
                this.updateUIState();
                this.stopMediaCycling();
                if (this.elements.container) {
                    this.elements.container.innerHTML = '';
                }
                
                if (this.state.fallbackToHome) {
                    // Switch to home list after clearing
                    this.switchToHomeList();
                    this.showStatusMessage(`Deleted ${charList?.name || 'character'}'s list - using home list`);
                } else {
                    // No fallback - show empty
                    this.showStatusMessage(`Deleted ${charList?.name || 'character'}'s list`);
                }
            }
            // If home is currently playing, continue normally (no action needed)
            
            this.updateCharacterListUI();
            this.updateListIndicators();
            
            // Update storage capacity after removing character list
            await this.checkStorageCapacity();
        }

        async addFilesToCharacterList(characterId, filesToAdd, fileMetadata) {
            // Ensure character list exists
            if (!this.state.characterLists.has(characterId)) {
                this.state.characterLists.set(characterId, {
                    name: this.state.currentCharacterName || 'Unknown',
                    files: [],
                    metadata: []
                });
            }
            
            const charList = this.state.characterLists.get(characterId);
            
            // Add files to character list
            filesToAdd.forEach(({ file, fileKey }) => {
                const fileObj = Object.assign(file, { fileKey });
                charList.files.push(fileObj);
                const objectURL = URL.createObjectURL(file);
                this.state.objectURLs.set(fileObj, objectURL);
            });
            
            // Add metadata
            charList.metadata = [...(charList.metadata || []), ...fileMetadata];
            
            // Save character lists
            this.saveCharacterLists();
            
            await this.checkStorageCapacity();
            
            // Check if Home was playing before we add files
            const wasHomePlaying = this.state.isEnabled && this.state.activeListType === 'home';
            
            // If this is the active character list, update state
            if (this.state.activeListType === 'character' && this.state.currentCharacterId === characterId) {
                // Reload the character list to get all files
                await this.loadCharacterMediaList(characterId);
                // Clear validation status and update to show new file count
                if (this.state.mediaFiles.length > 0) {
                    this.state.validationStatus = {
                        loaded: this.state.mediaFiles.length,
                        removed: 0
                    };
                } else {
                    this.state.validationStatus = null;
                }
                // If home was playing, continue playing character list
                if (wasHomePlaying && this.state.mediaFiles.length > 0) {
                    this.state.isEnabled = true;
                    this.startMediaCycling();
                    if (this.elements.toggleBtn) {
                        this.updatePlayPauseIcon();
                        this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn playing';
                    }
                    // Ensure media is visible
                    if (!this.state.isMediaVisible) {
                        this.state.isMediaVisible = true;
                        this.syncMediaVisibilityUI();
                    }
                }
                // Force UI update to show new file count and status
                this.updateUIState();
            } else if (this.state.isCharacterSpecificMode && this.state.currentCharacterId === characterId) {
                // Character is current but not active - switch to it now that it has files
                // Pass preservePlayback to smoothly transition from home if it was playing
                await this.switchToCharacterList(characterId, wasHomePlaying);
            }
            
            this.updateCharacterListUI();
            this.updateListIndicators();
        }

        async clearAllCharacterLists() {
            // Get all character IDs before clearing
            const characterIds = Array.from(this.state.characterLists.keys());
            
            // Clean up object URLs for all character files
            for (const characterId of characterIds) {
                const charList = this.state.characterLists.get(characterId);
                if (charList && charList.files) {
                    charList.files.forEach(file => {
                        const url = this.state.objectURLs.get(file);
                        if (url) URL.revokeObjectURL(url);
                        this.state.objectURLs.delete(file);
                    });
                }
            }
            
            // Remove all character file handles and blobs from IndexedDB
            if (this.db) {
                try {
                    // Remove all handles with character prefixes
                    const handleTransaction = this.db.transaction([CONFIG.INDEXEDDB_STORE], 'readwrite');
                    const handleStore = handleTransaction.objectStore(CONFIG.INDEXEDDB_STORE);
                    const handleIndex = handleStore.index('prefix');
                    const handleRequest = handleIndex.openCursor();
                    let deletedHandleCount = 0;
                    
                    await new Promise((resolve, reject) => {
                        handleTransaction.oncomplete = () => resolve();
                        handleTransaction.onerror = () => reject(handleTransaction.error);
                        
                        handleRequest.onsuccess = (event) => {
                            const cursor = event.target.result;
                            if (cursor) {
                                const prefix = cursor.value.prefix || '';
                                // Check if this is a character prefix (starts with 'char_')
                                if (prefix.startsWith('char_')) {
                                    cursor.delete();
                                    deletedHandleCount++;
                                }
                                cursor.continue();
                            }
                        };
                    });
                    
                    if (deletedHandleCount > 0) {
                        this.debugLog(`🗑️ ${EXTENSION_NAME}: Removed ${deletedHandleCount} file handles from IndexedDB for all characters`);
                    }
                    
                    // Remove all blobs with character prefixes
                    const blobTransaction = this.db.transaction([CONFIG.INDEXEDDB_BLOB_STORE], 'readwrite');
                    const blobStore = blobTransaction.objectStore(CONFIG.INDEXEDDB_BLOB_STORE);
                    const blobIndex = blobStore.index('prefix');
                    const blobRequest = blobIndex.openCursor();
                    let deletedBlobCount = 0;
                    
                    await new Promise((resolve, reject) => {
                        blobTransaction.oncomplete = () => resolve();
                        blobTransaction.onerror = () => reject(blobTransaction.error);
                        
                        blobRequest.onsuccess = (event) => {
                            const cursor = event.target.result;
                            if (cursor) {
                                const prefix = cursor.value.prefix || '';
                                // Check if this is a character prefix (starts with 'char_')
                                if (prefix.startsWith('char_')) {
                                    cursor.delete();
                                    deletedBlobCount++;
                                }
                                cursor.continue();
                            }
                        };
                    });
                    
                    if (deletedBlobCount > 0) {
                        this.debugLog(`🗑️ ${EXTENSION_NAME}: Removed ${deletedBlobCount} file blobs from IndexedDB for all characters`);
                    }
                } catch (e) {
                    this.debugWarn(`⚠️ ${EXTENSION_NAME}: Failed to remove handles/blobs from IndexedDB:`, e);
                }
            }
            
            // Remove all metadata from storage
            try {
                // Try ST extensionSettings first
                if (this.stContext && this.stContext.extensionSettings && 
                    this.stContext.extensionSettings[EXTENSION_NAME] &&
                    this.stContext.extensionSettings[EXTENSION_NAME].characterLists) {
                    this.stContext.extensionSettings[EXTENSION_NAME].characterLists = {};
                    if (typeof this.stContext.saveSettingsDebounced === 'function') {
                        this.stContext.saveSettingsDebounced();
                    }
                }
                
                // Also clear localStorage fallback
                localStorage.setItem(`${CONFIG.STORAGE_KEYS.FILES}_characterLists`, JSON.stringify({}));
            } catch (e) {
                this.debugWarn(`⚠️ ${EXTENSION_NAME}: Failed to remove metadata:`, e);
            }
            
            // Clear all from state
            this.state.characterLists.clear();
            this.saveCharacterLists();
            
            // If we were on a character list, switch to home
            if (this.state.activeListType === 'character') {
                if (this.state.fallbackToHome) {
                    await this.switchToHomeList();
                    this.showStatusMessage('All character folders deleted - using home list');
                } else {
                    // No fallback - clear media and show empty
                    this.state.mediaFiles = [];
                    this.state.currentIndex = 0;
                    this.state.activeListType = 'character';
                    this.state.currentCharacterId = null;
                    this.state.currentCharacterName = null;
                    this.cleanupObjectURLs();
                    this.state.isEnabled = false;
                    this.stopAndClearMedia();
                    if (this.elements.toggleBtn) {
                        this.updatePlayPauseIcon();
                        this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn paused';
                    }
                    this.updateUIState();
                    this.updateFileCountDisplay();
                    this.updateListIndicators();
                }
            }
            
            // Update storage capacity after clearing all character lists
            await this.checkStorageCapacity();
        }

        async loadCharacterMediaList(characterId) {
            const charList = this.state.characterLists.get(characterId);
            if (!charList || !charList.metadata || charList.metadata.length === 0) {
                this.state.mediaFiles = [];
                this.state.currentIndex = 0;
                this.state.activeListType = 'character';
                this.cleanupObjectURLs();
                this.updateUIState();
                this.updateFileCountDisplay();
                return;
            }
            
            const prefix = `char_${characterId}_`;
            const allBlobFiles = await this.loadFileBlobs(prefix);
            // Filter blob files to only include those in the metadata (in case IndexedDB has stale entries)
            const metadataKeys = new Set(charList.metadata.map(m => m.fileKey || `${m.name}-${m.size}-${m.lastModified}`));
            const blobFiles = allBlobFiles.filter(file => {
                const fileKey = file.fileKey || `${file.name}-${file.size}-${file.lastModified}`;
                return metadataKeys.has(fileKey);
            });
            if (blobFiles.length > 0) {
                this.state.mediaFiles = blobFiles;
                blobFiles.forEach(file => {
                    const objectURL = URL.createObjectURL(file);
                    this.state.objectURLs.set(file, objectURL);
                });
                this.state.validationStatus = { loaded: blobFiles.length, removed: 0 };
                this.state.activeListType = 'character';
                this.updateUIState();
                this.updateFileCountDisplay();
                this.updateListIndicators();
                this.debugLog(`📁 ${EXTENSION_NAME}: Loaded ${blobFiles.length} files from IndexedDB blob storage for character ${characterId}${allBlobFiles.length > blobFiles.length ? ` (filtered ${allBlobFiles.length - blobFiles.length} stale entries)` : ''}`);
                return;
            }
            
            // No files found at all
            this.debugWarn(`⚠️ ${EXTENSION_NAME}: No files found for character ${characterId} (${charList.metadata.length} metadata entries, ${allBlobFiles.length} blobs)`);
            this.state.mediaFiles = [];
            this.state.currentIndex = 0;
            this.state.activeListType = 'character';
            this.cleanupObjectURLs();
            this.updateUIState();
            this.updateFileCountDisplay();
            this.updateListIndicators();
        }

        async saveCharacterLists() {
            try {
                // Convert Map to serializable format
                const listsData = {};
                this.state.characterLists.forEach((list, charId) => {
                    listsData[charId] = {
                        name: list.name,
                        metadata: list.metadata || []
                        // Don't save files directly - they're stored via handles
                    };
                });
                
                if (this.stContext && this.stContext.extensionSettings) {
                    if (!this.stContext.extensionSettings[EXTENSION_NAME]) {
                        this.stContext.extensionSettings[EXTENSION_NAME] = {};
                    }
                    this.stContext.extensionSettings[EXTENSION_NAME].characterLists = listsData;
                    if (typeof this.stContext.saveSettingsDebounced === 'function') {
                        this.stContext.saveSettingsDebounced();
                    }
                }
                localStorage.setItem(`${CONFIG.STORAGE_KEYS.FILES}_characterLists`, JSON.stringify(listsData));
                this.debugLog(`💾 ${EXTENSION_NAME}: Saved character lists`);
            } catch (e) {
                this.debugWarn('⚠️ Failed to save character lists:', e);
            }
        }

        async loadCharacterLists() {
            try {
                // Try ST extensionSettings first
                if (this.stContext && this.stContext.extensionSettings && 
                    this.stContext.extensionSettings[EXTENSION_NAME] &&
                    this.stContext.extensionSettings[EXTENSION_NAME].characterLists) {
                    const listsData = this.stContext.extensionSettings[EXTENSION_NAME].characterLists;
                    this.state.characterLists.clear();
                    Object.entries(listsData).forEach(([charId, data]) => {
                        this.state.characterLists.set(charId, {
                            name: data.name,
                            files: [],
                            metadata: data.metadata || []
                        });
                    });
                    this.debugLog(`📁 ${EXTENSION_NAME}: Loaded ${this.state.characterLists.size} character lists from ST extensionSettings`);
                    return;
                }
                
                // Fallback to localStorage
                const saved = localStorage.getItem(`${CONFIG.STORAGE_KEYS.FILES}_characterLists`);
                if (saved) {
                    const listsData = JSON.parse(saved);
                    this.state.characterLists.clear();
                    Object.entries(listsData).forEach(([charId, data]) => {
                        this.state.characterLists.set(charId, {
                            name: data.name,
                            files: [],
                            metadata: data.metadata || []
                        });
                    });
                    this.debugLog(`📁 ${EXTENSION_NAME}: Loaded ${this.state.characterLists.size} character lists from localStorage`);
                }
            } catch (e) {
                this.debugWarn('⚠️ Failed to load character lists:', e);
            }
        }

        async initIndexedDB() {
            return new Promise((resolve, reject) => {
                if (!('indexedDB' in window)) {
                    this.debugWarn('⚠️ IndexedDB not supported');
                    resolve(null);
                    return;
                }

                const request = indexedDB.open(CONFIG.INDEXEDDB_NAME, CONFIG.INDEXEDDB_VERSION);

                request.onerror = () => {
                    this.debugError('❌ IndexedDB open failed:', request.error);
                    resolve(null);
                };

                request.onsuccess = () => {
                    this.db = request.result;
                    this.debugLog('✅ IndexedDB opened successfully');
                    resolve(this.db);
                };

                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    const transaction = event.target.transaction;
                    
                    // Create fileHandles store if it doesn't exist
                    if (!db.objectStoreNames.contains(CONFIG.INDEXEDDB_STORE)) {
                        const objectStore = db.createObjectStore(CONFIG.INDEXEDDB_STORE, { keyPath: 'id', autoIncrement: true });
                        objectStore.createIndex('fileKey', 'fileKey', { unique: true });
                        objectStore.createIndex('prefix', 'prefix', { unique: false });
                        this.debugLog('✅ IndexedDB fileHandles store created');
                    } else {
                        // Add prefix index if upgrading
                        const objectStore = transaction.objectStore(CONFIG.INDEXEDDB_STORE);
                        if (!objectStore.indexNames.contains('prefix')) {
                            objectStore.createIndex('prefix', 'prefix', { unique: false });
                            this.debugLog('✅ IndexedDB fileHandles store upgraded with prefix index');
                        }
                    }
                    
                    // Create fileBlobs store for fallback method (version 2+)
                    if (!db.objectStoreNames.contains(CONFIG.INDEXEDDB_BLOB_STORE)) {
                        const blobStore = db.createObjectStore(CONFIG.INDEXEDDB_BLOB_STORE, { keyPath: 'fileKey' });
                        blobStore.createIndex('prefix', 'prefix', { unique: false });
                        this.debugLog('✅ IndexedDB fileBlobs store created');
                    }
                };
            });
        }

        createUIElements() {
            // Create media container
            this.elements.container = this.createElement('div', {
                id: 'mediaCyclerContainer',
                className: 'media-cycler-container'
            });

            // Create control panel - circular design (circle container IS the controls)
            this.elements.circleContainer = this.createElement('div', {
                id: 'mediaCyclerControls',
                className: 'media-cycler-circle-container media-cycler-controls'
            });
            
            // Keep controls reference pointing to circleContainer for compatibility
            this.elements.controls = this.elements.circleContainer;

            // Top half of circle - Info section
            this.elements.topHalf = this.createElement('div', {
                className: 'media-cycler-top-half'
            });
            
            // Top info container
            this.elements.topInfoContainer = this.createElement('div', {
                className: 'media-cycler-top-info'
            });
            
            // Active list indicator
            this.elements.activeListIndicator = this.createElement('div', {
                className: 'media-cycler-active-indicator'
            });
            
            // Character name indicator
            this.elements.characterNameIndicator = this.createElement('div', {
                className: 'media-cycler-character-indicator'
            });

            // File count display
            this.elements.fileCount = this.createElement('div', {
                className: 'media-cycler-file-count'
            });

            // Status display
            this.elements.status = this.createElement('div', {
                className: 'media-cycler-status'
            });

            this.elements.topInfoContainer.append(
                this.elements.activeListIndicator,
                this.elements.characterNameIndicator,
                this.elements.fileCount,
                this.elements.status
            );
            
            // Lock/eye buttons positioned at 2 o'clock outside the circle (not in top half anymore)
            // Eye button (shows when controls are visible)
            // Icon represents current state: closed eye = controls hidden, open eye = controls visible
            // Hover shows preview of what will happen when clicked
            this.elements.hideControlsEyeBtn = this.createElement('button', {
                className: 'media-cycler-external-button media-cycler-eye-btn',
                title: 'Click to hide controls'
            });
            // Open eye icon (controls visible)
            const openEyeIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
            // Closed eye icon (controls hidden)
            const closedEyeIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
            // Start with open eye (controls visible when button is shown)
            this.elements.hideControlsEyeBtn.innerHTML = openEyeIcon;
            // Store icons for hover effect
            this.elements.hideControlsEyeBtn.dataset.openIcon = openEyeIcon;
            this.elements.hideControlsEyeBtn.dataset.closedIcon = closedEyeIcon;
            
            // Hover effect: show preview of what will happen
            this.elements.hideControlsEyeBtn.addEventListener('mouseenter', () => {
                const openEyeIcon = this.elements.hideControlsEyeBtn.dataset.openIcon;
                const closedEyeIcon = this.elements.hideControlsEyeBtn.dataset.closedIcon;
                // Show opposite icon on hover (preview of what clicking will do)
                if (this.state.isUIVisible) {
                    this.elements.hideControlsEyeBtn.innerHTML = closedEyeIcon; // Will hide controls
                } else {
                    this.elements.hideControlsEyeBtn.innerHTML = openEyeIcon; // Will show controls
                }
            });
            this.elements.hideControlsEyeBtn.addEventListener('mouseleave', () => {
                const openEyeIcon = this.elements.hideControlsEyeBtn.dataset.openIcon;
                const closedEyeIcon = this.elements.hideControlsEyeBtn.dataset.closedIcon;
                // Restore icon based on current state
                if (this.state.isUIVisible) {
                    this.elements.hideControlsEyeBtn.innerHTML = openEyeIcon;
                } else {
                    this.elements.hideControlsEyeBtn.innerHTML = closedEyeIcon;
                }
            });
            
            this.elements.hideControlsEyeBtn.addEventListener('click', () => {
                // Only toggle controls UI visibility, not media UI
                this.state.isUIVisible = !this.state.isUIVisible;
                this.updateUIVisibility();
                this.updateEyeButtons();
            });
            this.elements.hideControlsEyeBtn.style.display = 'none'; // Hidden by default
            
            // Lock/Unlock button
            this.elements.movableBtn = this.createElement('button', {
                className: 'media-cycler-external-button media-cycler-lock-btn',
                title: 'Unlock (Enable Movable Mode)'
            });
            // Locked icon (default when not in movable mode)
            const lockedIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
            // Unlocked icon (hover preview when locked, default when unlocked)
            const unlockedIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 5-5 4.8 4.8 0 0 1 4 5"/></svg>';
            this.elements.movableBtn.innerHTML = lockedIcon;
            // Store icons for hover effect
            this.elements.movableBtn.dataset.lockedIcon = lockedIcon;
            this.elements.movableBtn.dataset.unlockedIcon = unlockedIcon;
            
            // Hover effect: show opposite icon on hover
            this.elements.movableBtn.addEventListener('mouseenter', () => {
                if (this.state.isMovableMode) {
                    // Currently unlocked, show locked icon on hover
                    this.elements.movableBtn.innerHTML = lockedIcon;
                } else {
                    // Currently locked, show unlocked icon on hover
                    this.elements.movableBtn.innerHTML = unlockedIcon;
                }
            });
            this.elements.movableBtn.addEventListener('mouseleave', () => {
                // Restore current state icon
                if (this.state.isMovableMode) {
                    this.elements.movableBtn.innerHTML = unlockedIcon;
                } else {
                    this.elements.movableBtn.innerHTML = lockedIcon;
                }
            });
            
            this.elements.movableBtn.addEventListener('click', this.toggleMovableMode);
            
            // Storage capacity indicator (circular progress, non-clickable)
            this.elements.storageIndicator = this.createElement('div', {
                className: 'media-cycler-external-button media-cycler-storage-indicator',
                title: 'Storage capacity'
            });
            // Create SVG for circular progress indicator (fills from bottom like Breath of the Wild stamina)
            // Use a full circle path that starts at 6 o'clock (bottom) and goes clockwise
            // Path: M 10 18 (6 o'clock) -> arc to 10 2 (12 o'clock) -> arc back to 10 18 (6 o'clock)
            const storageIndicatorSVG = `
                <svg width="20" height="20" viewBox="0 0 20 20">
                    <!-- Background circle -->
                    <circle cx="10" cy="10" r="8" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="2"/>
                    <!-- Progress circle - full circle path starting at 6 o'clock, going clockwise -->
                    <path d="M 10 18 A 8 8 0 0 1 10 2 A 8 8 0 0 1 10 18" fill="none" stroke="currentColor" stroke-width="2" 
                          stroke-linecap="round" stroke-dasharray="0 50.27" 
                          class="storage-progress-circle"/>
                </svg>
            `;
            this.elements.storageIndicator.innerHTML = storageIndicatorSVG;
            this.elements.storageProgressCircle = this.elements.storageIndicator.querySelector('.storage-progress-circle');
            this.elements.storageIndicator.style.display = 'none'; // Hidden by default (only show for fallback browsers)
            this.elements.storageIndicator.style.pointerEvents = 'none'; // Non-clickable
            this.elements.storageIndicator.style.cursor = 'default';
            
            // Background Mode button
            this.elements.backgroundModeBtn = this.createElement('button', {
                className: 'media-cycler-external-button media-cycler-background-mode-btn',
                title: 'Background Mode: Fullscreen media background'
            });
            // Fullscreen enter icon (expanding arrows - when background mode is ON)
            const fullscreenEnterIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
            // Fullscreen exit icon (contracting arrows - when background mode is OFF)
            const fullscreenExitIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>';
            // Start with fullscreen exit icon (background mode is OFF initially)
            this.elements.backgroundModeBtn.innerHTML = fullscreenExitIcon;
            // Store icons for hover effect
            this.elements.backgroundModeBtn.dataset.enterIcon = fullscreenEnterIcon;
            this.elements.backgroundModeBtn.dataset.exitIcon = fullscreenExitIcon;
            
            // Hover effect: show preview of what will happen
            this.elements.backgroundModeBtn.addEventListener('mouseenter', () => {
                // If background mode is OFF (exit icon), show enter icon on hover (preview entering fullscreen)
                // If background mode is ON (enter icon), show exit icon on hover (preview exiting fullscreen)
                if (!this.state.isBackgroundMode) {
                    this.elements.backgroundModeBtn.innerHTML = fullscreenEnterIcon;
                } else {
                    this.elements.backgroundModeBtn.innerHTML = fullscreenExitIcon;
                }
            });
            this.elements.backgroundModeBtn.addEventListener('mouseleave', () => {
                // Restore current state icon
                if (this.state.isBackgroundMode) {
                    this.elements.backgroundModeBtn.innerHTML = fullscreenEnterIcon;
                } else {
                    this.elements.backgroundModeBtn.innerHTML = fullscreenExitIcon;
                }
            });
            
            this.elements.backgroundModeBtn.addEventListener('click', () => this.toggleBackgroundMode());
            
            // Append buttons directly to circle container (they'll be positioned absolutely at 2 o'clock)
            // Note: We'll append these after the circle container is fully set up
            
            // Top half only contains info now
            this.elements.topHalf.append(this.elements.topInfoContainer);

            // Bottom half of circle - Quick actions or tab content
            this.elements.bottomHalf = this.createElement('div', {
                className: 'media-cycler-bottom-half'
            });
            
            // Quick actions container (shown when Controls tab is active)
            this.elements.quickActions = this.createElement('div', {
                className: 'media-cycler-quick-actions active'
            });
            
            // Spotify-style controls: Previous, Play/Pause, Next, Shuffle, Volume
            // Previous button (reverse)
            this.elements.prevBtn = this.createSTButton('', 'media-cycler-prev media-cycler-quick-action', this.handlePrevMedia);
            this.elements.prevBtn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';
            this.elements.prevBtn.setAttribute('title', 'Previous');
            
            // Play/Pause button (center, larger)
            this.elements.toggleBtn = this.createSTButton('', 'media-cycler-toggle media-cycler-quick-action media-cycler-play-btn', this.togglePlayPause);
            this.elements.toggleBtn.innerHTML = '<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
            this.elements.toggleBtn.setAttribute('title', 'Play');
            
            // Next button
            this.elements.nextBtn = this.createSTButton('', 'media-cycler-next media-cycler-quick-action', this.handleNextMedia);
            this.elements.nextBtn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
            this.elements.nextBtn.setAttribute('title', 'Next');
            
            // Shuffle button
            this.elements.shuffleBtn = this.createSTButton('', 'media-cycler-shuffle media-cycler-quick-action', this.toggleShuffleMode);
            this.elements.shuffleBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>';
            this.elements.shuffleBtn.setAttribute('title', 'Shuffle Off');
            
            // Volume container with icon and slider
            const volumeQuickContainer = this.createElement('div', {
                className: 'media-cycler-volume-quick',
                style: 'display: flex; align-items: center; gap: 8px; width: 100%; max-width: 180px;'
            });
            
            // Volume icon (clickable button)
            const volumeIcon = this.createElement('button', {
                className: 'media-cycler-volume-icon',
                style: 'width: 24px; height: 24px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: transparent; border: none; padding: 0; cursor: pointer; user-select: none; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; color: var(--text-color, inherit);'
            });
            volumeIcon.draggable = false;
            volumeIcon.addEventListener('dragstart', (e) => e.preventDefault());
            // Start with muted icon
            volumeIcon.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6"/></svg>';
            volumeIcon.setAttribute('title', 'Unmute (click to enable audio)');
            this.elements.volumeIcon = volumeIcon;
            
            // Click handler for volume icon - unmute at half volume
            volumeIcon.addEventListener('click', () => {
                if (!this.state.isAudioEnabled) {
                    // Unmute and set to half volume
                    this.state.isAudioEnabled = true;
                    this.state.volume = 0.5;
                    this.updateVolumeIcon(this.state.volume);
                    // Update slider
                    if (this.elements.volumeQuickInput) {
                        this.elements.volumeQuickInput.value = 0.5;
                    }
                    // Sync with settings if exists
                    if (this.elements.volumeInput) {
                        this.elements.volumeInput.value = 0.5;
                    }
                    if (this.elements.volumeValueDisplay) {
                        this.elements.volumeValueDisplay.textContent = '0.5';
                    }
                    // Apply to current media
                    if (this.state.currentMedia?.tagName === 'VIDEO') {
                        try {
                            this.state.currentMedia.muted = false;
                            this.state.currentMedia.volume = 0.5;
                        } catch (e) {}
                    }
                    this.saveSettings();
                    volumeIcon.setAttribute('title', 'Mute (click to disable audio)');
                } else {
                    // Mute
                    this.state.isAudioEnabled = false;
                    this.updateVolumeIcon(0);
                    if (this.state.currentMedia?.tagName === 'VIDEO') {
                        try {
                            this.state.currentMedia.muted = true;
                        } catch (e) {}
                    }
                    this.saveSettings();
                    volumeIcon.setAttribute('title', 'Unmute (click to enable audio)');
                }
            });
            
            const volumeQuickInput = this.createElement('input', {
                type: 'range',
                className: 'media-cycler-volume-slider',
                min: 0,
                max: 1,
                step: 0.1,
                value: this.state.volume
            });
            this.elements.volumeQuickInput = volumeQuickInput;
            
            volumeQuickInput.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) {
                    const clampedVal = Math.max(0, Math.min(1, val));
                    this.state.volume = clampedVal;
                    // Unmute when slider is moved
                    if (!this.state.isAudioEnabled && clampedVal > 0) {
                        this.state.isAudioEnabled = true;
                        if (this.state.currentMedia?.tagName === 'VIDEO') {
                            try {
                                this.state.currentMedia.muted = false;
                            } catch (e) {}
                        }
                        if (this.elements.volumeIcon) {
                            this.elements.volumeIcon.setAttribute('title', 'Mute (click to disable audio)');
                        }
                    }
                    // Update volume icon based on level
                    this.updateVolumeIcon(clampedVal);
                    // Sync with settings volume input if it exists
                    if (this.elements.volumeInput) {
                        this.elements.volumeInput.value = clampedVal;
                    }
                    if (this.elements.volumeValueDisplay) {
                        this.elements.volumeValueDisplay.textContent = clampedVal.toFixed(1);
                    }
                    if (this.state.currentMedia?.tagName === 'VIDEO') {
                        this.state.currentMedia.volume = this.state.volume;
                    }
                    this.saveSettings();
                }
            });
            
            volumeQuickContainer.append(volumeIcon, volumeQuickInput);
            
            // Controls row: Previous, Play/Pause, Next
            const controlsRow = this.createElement('div', {
                className: 'media-cycler-controls-row',
                style: 'display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%;'
            });
            
            // TEMPORARY FIX: Dummy button as first child to prevent first-child CSS issues with prev button
            // DO NOT DELETE - This fixes the white boxes/tab lighting issue when hovering prev button
            // Make it identical to prev button but invisible, non-interactive, and takes up no space
            const dummyBtn = this.createSTButton('', 'media-cycler-prev media-cycler-quick-action', () => {});
            dummyBtn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';
            dummyBtn.style.opacity = '0';
            dummyBtn.style.pointerEvents = 'none';
            dummyBtn.style.visibility = 'hidden';
            dummyBtn.style.width = '0';
            dummyBtn.style.height = '0';
            dummyBtn.style.minWidth = '0';
            dummyBtn.style.minHeight = '0';
            dummyBtn.style.margin = '0';
            dummyBtn.style.padding = '0';
            dummyBtn.style.border = 'none';
            dummyBtn.style.background = 'transparent';
            dummyBtn.style.overflow = 'hidden';
            dummyBtn.style.flexShrink = '0';
            dummyBtn.style.flexGrow = '0';
            
            controlsRow.append(dummyBtn, this.elements.prevBtn, this.elements.toggleBtn, this.elements.nextBtn);
            
            // Bottom row: Shuffle, Volume
            const bottomRow = this.createElement('div', {
                className: 'media-cycler-controls-bottom',
                style: 'display: flex; align-items: center; justify-content: center; gap: 8px; width: 69%; margin-top: 12px;'
            });
            bottomRow.append(this.elements.shuffleBtn, volumeQuickContainer);
            
            this.elements.quickActions.append(controlsRow, bottomRow);
            
            this.elements.bottomHalf.append(this.elements.quickActions);

            // Create side tabs (organizer style)
            // Create icon buttons for tabs - positioned along the circle's right edge
            // Controls button (play icon) - positioned at 1 o'clock
            const controlsTab = this.createElement('button', {
                className: 'media-cycler-tab-btn media-cycler-tab-controls active',
                'data-tab': 'controls',
                title: 'Controls'
            });
            controlsTab.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 5v14l11-7z"/></svg>';
            controlsTab.addEventListener('click', () => this.switchTab('controls'));
            
            // Home button (home/list icon) - positioned at 3 o'clock
            const mainTab = this.createElement('button', {
                className: 'media-cycler-tab-btn media-cycler-tab-main',
                'data-tab': 'home',
                title: 'Home'
            });
            mainTab.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
            mainTab.addEventListener('click', () => this.switchTab('home'));
            
            // Settings button (wrench/cog icon) - positioned at 5 o'clock
            const settingsTab = this.createElement('button', {
                className: 'media-cycler-tab-btn media-cycler-tab-settings',
                'data-tab': 'settings',
                title: 'Settings'
            });
            settingsTab.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
            settingsTab.addEventListener('click', () => this.switchTab('settings'));
            
            // Characters button (users icon) - positioned at 7 o'clock
            const charactersTab = this.createElement('button', {
                className: 'media-cycler-tab-btn media-cycler-tab-characters',
                'data-tab': 'characters',
                title: 'Characters'
            });
            charactersTab.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
            charactersTab.addEventListener('click', () => this.switchTab('characters'));
            
            this.elements.tabs = { controlsTab, mainTab, settingsTab, charactersTab };
            
            // Position buttons along the circle's right edge (user-adjusted positions)
            controlsTab.style.top = '89px';
            controlsTab.style.left = '280px';
            
            mainTab.style.top = '125px';
            mainTab.style.left = '283px';
            
            charactersTab.style.top = '161px';
            charactersTab.style.left = '278px';
            
            settingsTab.style.top = '196px';
            settingsTab.style.left = '266px';
            
            // Assemble circle container (which is now the controls)
            this.elements.circleContainer.append(this.elements.topHalf, this.elements.bottomHalf);
            
            // Append tab buttons to circle container (positioned along right edge)
            this.elements.circleContainer.append(controlsTab, mainTab, settingsTab, charactersTab);
            
            // Append lock/eye buttons, storage indicator, and background mode button to circle container (positioned at 2 o'clock)
            this.elements.circleContainer.append(this.elements.hideControlsEyeBtn, this.elements.movableBtn, this.elements.storageIndicator, this.elements.backgroundModeBtn);

            // Home tab content (displayed in bottom half when selected)
            const mainContent = this.createElement('div', {
                className: 'media-cycler-tab-content',
                id: 'mediaCyclerMainContent'
            });
            
            // Home list file count status (above buttons)
            this.elements.homeListStatus = this.createElement('div', {
                className: 'media-cycler-status',
                style: 'text-align: center; margin-bottom: 8px;'
            });
            
            const mainButtonsContainer = this.createElement('div', {
                className: 'media-cycler-button-group',
                style: 'display: flex; flex-direction: row; gap: 0.75em; width: 100%; justify-content: center; align-items: center; top: 5px; position: relative;'
            });
            
            // Edit button - icon button (same size as forward/reverse)
            this.elements.mainAddBtn = this.createSTButton('', 'media-cycler-main-add media-cycler-icon-btn', () => {
                this.state.pendingFileSelection = { listType: 'home', characterId: null };
                this.elements.fileInput.click();
            });
            this.elements.mainAddBtn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
            this.elements.mainAddBtn.setAttribute('title', 'Edit: Click to add files. To remove a file, select that file in the picker and choose "Removal & Keep New" when the duplicate message appears.');
            
            // Wipe button - icon button (same size as forward/reverse)
            this.elements.mainClearBtn = this.createSTButton('', 'media-cycler-main-clear media-cycler-icon-btn', async () => await this.clearSavedFiles('home'));
            this.elements.mainClearBtn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
            this.elements.mainClearBtn.setAttribute('title', 'Wipe: Clears the home media list');
            mainButtonsContainer.append(this.elements.mainAddBtn, this.elements.mainClearBtn);
            mainContent.append(this.elements.homeListStatus, mainButtonsContainer);
            
            this.elements.mainTab = mainTab;
            this.elements.mainContent = mainContent;
            
            // Settings panel content
            const settingsContent = this.createElement('div', {
                className: 'media-cycler-tab-content',
                id: 'mediaCyclerSettingsContent'
            });
            
            // Compact settings container
            const settingsContainer = this.createElement('div', {
                style: 'display: flex; flex-direction: column; gap: 12px; width: 100%;'
            });
            
            // Image duration - compact text input
            const imageDurationRow = this.createElement('div', {
                style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px;'
            });
            const imageLabel = this.createElement('label', {
                style: 'font-size: 12px; color: var(--text-color, rgba(255,255,255,0.8)); white-space: nowrap;'
            });
            imageLabel.textContent = 'Image';
            imageLabel.setAttribute('title', 'How long each image is shown (seconds, min: 2)');
            const imageInputContainer = this.createElement('div', {
                style: 'display: flex; align-items: center; gap: 6px; flex: 1; max-width: 80px; position: relative; left: -20px;'
            });
            const imageDurationInput = this.createElement('input', {
                type: 'text',
                style: 'width: 40px; padding: 4px 6px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: var(--text-color, white); font-size: 12px; text-align: center;',
                value: this.state.imageDuration / 1000,
                pattern: '[0-9]*',
                inputmode: 'numeric'
            });
            const imageSecLabel = this.createElement('span', {
                style: 'font-size: 11px; color: var(--text-color, rgba(255,255,255,0.6));'
            });
            imageSecLabel.textContent = 's';
            imageInputContainer.append(imageDurationInput, imageSecLabel);
            imageDurationRow.append(imageLabel, imageInputContainer);
            
            imageDurationInput.addEventListener('input', () => {
                const val = parseInt(imageDurationInput.value, 10);
                if (!isNaN(val) && val >= 2) {
                    this.state.imageDuration = val * 1000;
                    this.saveSettings();
                    if (this.state.isEnabled && this.state.cycleTimeout && this.state.currentMedia?.tagName === 'IMG') {
                        if (!this.state.mediaStartTime) {
                            this.state.mediaStartTime = Date.now();
                        }
                        this.scheduleNextMedia();
                    }
                }
            });
            imageDurationInput.addEventListener('blur', () => {
                const val = parseInt(imageDurationInput.value, 10);
                const clampedSec = (isNaN(val) || val < 2) ? 2 : val;
                imageDurationInput.value = clampedSec;
                this.state.imageDuration = clampedSec * 1000;
                this.saveSettings();
                if (clampedSec === 2 && (isNaN(val) || val < 2)) {
                    this.showStatusMessage('Minimum duration is 2 seconds');
                }
                if (this.state.isEnabled && this.state.cycleTimeout && this.state.currentMedia?.tagName === 'IMG') {
                    if (!this.state.mediaStartTime) {
                        this.state.mediaStartTime = Date.now();
                    }
                    this.scheduleNextMedia();
                }
            });
            
            // Video duration - compact text input with "play until end" icon button
            const videoDurationRow = this.createElement('div', {
                style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px;'
            });
            const videoLabel = this.createElement('label', {
                style: 'font-size: 12px; color: var(--text-color, rgba(255,255,255,0.8)); white-space: nowrap;'
            });
            videoLabel.textContent = 'Video';
            videoLabel.setAttribute('title', 'Min/max seconds: short clips loop until min; long clips cap at max (both min 2s)');
            const videoInputContainer = this.createElement('div', {
                style: 'display: flex; align-items: center; gap: 4px; flex: 1; max-width: 140px;'
            });
            const videoMinDurationInput = this.createElement('input', {
                type: 'text',
                style: 'width: 32px; padding: 4px 4px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: var(--text-color, white); font-size: 12px; text-align: center;',
                value: this.state.videoMinDuration / 1000,
                pattern: '[0-9]*',
                inputmode: 'numeric',
                disabled: this.state.playVideoUntilEnd
            });
            videoMinDurationInput.setAttribute('title', 'Min seconds (loop short clips until this)');
            this.elements.videoMinDurationInput = videoMinDurationInput;
            const videoMaxDurationInput = this.createElement('input', {
                type: 'text',
                style: 'width: 32px; padding: 4px 4px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: var(--text-color, white); font-size: 12px; text-align: center;',
                value: this.state.videoMaxDuration / 1000,
                pattern: '[0-9]*',
                inputmode: 'numeric',
                disabled: this.state.playVideoUntilEnd
            });
            videoMaxDurationInput.setAttribute('title', 'Max seconds (cap long clips at this)');
            this.elements.videoMaxDurationInput = videoMaxDurationInput;
            this.elements.videoDurationInput = videoMaxDurationInput;
            const videoSecLabel1 = this.createElement('span', { style: 'font-size: 11px; color: var(--text-color, rgba(255,255,255,0.6));' });
            videoSecLabel1.textContent = 's';
            const videoSecLabel2 = this.createElement('span', { style: 'font-size: 11px; color: var(--text-color, rgba(255,255,255,0.6));' });
            videoSecLabel2.textContent = 's';
            videoMinDurationInput.style.opacity = this.state.playVideoUntilEnd ? '0.5' : '1';
            videoMaxDurationInput.style.opacity = this.state.playVideoUntilEnd ? '0.5' : '1';
            
            // Play until end icon button
            const playUntilEndBtn = this.createSTButton('', 'media-cycler-play-until-end', () => {
                this.state.playVideoUntilEnd = !this.state.playVideoUntilEnd;
                this.saveSettings();
                if (videoMinDurationInput) {
                    videoMinDurationInput.disabled = this.state.playVideoUntilEnd;
                    videoMinDurationInput.style.opacity = this.state.playVideoUntilEnd ? '0.5' : '1';
                }
                if (videoMaxDurationInput) {
                    videoMaxDurationInput.disabled = this.state.playVideoUntilEnd;
                    videoMaxDurationInput.style.opacity = this.state.playVideoUntilEnd ? '0.5' : '1';
                }
                // Update button icon
                if (this.state.playVideoUntilEnd) {
                    playUntilEndBtn.classList.add('toggle-active');
                    playUntilEndBtn.setAttribute('title', 'Play video until it ends (minimum 2 seconds, loops if shorter)');
                } else {
                    playUntilEndBtn.classList.remove('toggle-active');
                    playUntilEndBtn.setAttribute('title', 'Play video until it ends instead of using duration (minimum 2 seconds, loops if shorter)');
                }
                if (this.state.currentMedia?.tagName === 'VIDEO') {
                    const video = this.state.currentMedia;
                    // Clear any existing minimum duration timeout
                    if (this.state.videoMinDurationTimeout) {
                        clearTimeout(this.state.videoMinDurationTimeout);
                        this.state.videoMinDurationTimeout = null;
                    }
                    video.loop = !this.state.isEnabled || !this.state.playVideoUntilEnd;
                    if (this.state.playVideoUntilEnd && this.state.isEnabled) {
                        if (this.state.cycleTimeout) {
                            clearTimeout(this.state.cycleTimeout);
                            this.state.cycleTimeout = null;
                        }
                        // Track when video started and check duration
                        this.state.videoPlayStartTime = Date.now();
                        const videoDuration = video.duration || 0;
                        if (videoDuration > 0 && videoDuration < 2) {
                            // Video is less than 2 seconds - enable looping temporarily
                            video.loop = true;
                            this.state.videoMinDurationTimeout = setTimeout(() => {
                                if (this.state.isEnabled && this.state.currentMedia === video) {
                                    video.loop = false;
                                    video.pause();
                                    this.debugLog('🎬 Video played for minimum 2 seconds, moving to next media');
                                    this.showNextMedia();
                                }
                            }, 2000);
                        } else {
                            // Video is 2+ seconds - play until end normally
                            video.loop = false;
                            video.addEventListener('ended', () => {
                                if (this.state.isEnabled && this.state.currentMedia === video) {
                                    this.showNextMedia();
                                }
                            }, { once: true });
                        }
                    } else if (!this.state.playVideoUntilEnd && this.state.isEnabled) {
                        this.scheduleNextMedia();
                    }
                }
            });
            playUntilEndBtn.setAttribute('title', 'Play video until it ends instead of min/max duration (minimum 2 seconds, loops if shorter)');
            playUntilEndBtn.style.width = '28px';
            playUntilEndBtn.style.height = '28px';
            playUntilEndBtn.style.padding = '0';
            playUntilEndBtn.style.minWidth = '28px';
            playUntilEndBtn.style.minHeight = '28px';
            playUntilEndBtn.style.borderRadius = '4px';
            playUntilEndBtn.style.display = 'flex';
            playUntilEndBtn.style.alignItems = 'center';
            playUntilEndBtn.style.justifyContent = 'center';
            playUntilEndBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/><line x1="15" y1="12" x2="3" y2="12"/></svg>';
            if (this.state.playVideoUntilEnd) {
                playUntilEndBtn.classList.add('toggle-active');
            }
            this.elements.playVideoUntilEndToggle = playUntilEndBtn;

            const applyVideoDurationFromInputs = () => {
                let minSec = parseInt(videoMinDurationInput.value, 10);
                let maxSec = parseInt(videoMaxDurationInput.value, 10);
                const hadInvalid = (isNaN(minSec) || minSec < 2) || (isNaN(maxSec) || maxSec < 2);
                minSec = (isNaN(minSec) || minSec < 2) ? 2 : minSec;
                maxSec = (isNaN(maxSec) || maxSec < 2) ? 2 : maxSec;
                if (minSec > maxSec) maxSec = minSec;
                videoMinDurationInput.value = minSec;
                videoMaxDurationInput.value = maxSec;
                this.state.videoMinDuration = minSec * 1000;
                this.state.videoMaxDuration = maxSec * 1000;
                this.saveSettings();
                if (hadInvalid) this.showStatusMessage('Minimum duration is 2 seconds');
                if (this.state.isEnabled && this.state.cycleTimeout && this.state.currentMedia?.tagName === 'VIDEO') {
                    if (!this.state.mediaStartTime) this.state.mediaStartTime = Date.now();
                    this.scheduleNextMedia();
                }
            };
            videoMinDurationInput.addEventListener('input', () => {
                const val = parseInt(videoMinDurationInput.value, 10);
                if (!isNaN(val) && val >= 2) {
                    this.state.videoMinDuration = val * 1000;
                    if (this.state.videoMinDuration > this.state.videoMaxDuration) {
                        this.state.videoMaxDuration = this.state.videoMinDuration;
                        videoMaxDurationInput.value = this.state.videoMaxDuration / 1000;
                    }
                    this.saveSettings();
                    if (this.state.isEnabled && this.state.cycleTimeout && this.state.currentMedia?.tagName === 'VIDEO') {
                        if (!this.state.mediaStartTime) this.state.mediaStartTime = Date.now();
                        this.scheduleNextMedia();
                    }
                }
            });
            videoMinDurationInput.addEventListener('blur', () => { applyVideoDurationFromInputs(); });
            videoMaxDurationInput.addEventListener('input', () => {
                const val = parseInt(videoMaxDurationInput.value, 10);
                if (!isNaN(val) && val >= 2) {
                    this.state.videoMaxDuration = val * 1000;
                    if (this.state.videoMaxDuration < this.state.videoMinDuration) {
                        this.state.videoMinDuration = this.state.videoMaxDuration;
                        videoMinDurationInput.value = this.state.videoMinDuration / 1000;
                    }
                    this.saveSettings();
                    if (this.state.isEnabled && this.state.cycleTimeout && this.state.currentMedia?.tagName === 'VIDEO') {
                        if (!this.state.mediaStartTime) this.state.mediaStartTime = Date.now();
                        this.scheduleNextMedia();
                    }
                }
            });
            videoMaxDurationInput.addEventListener('blur', () => { applyVideoDurationFromInputs(); });

            videoInputContainer.append(videoMinDurationInput, videoSecLabel1, videoMaxDurationInput, videoSecLabel2, playUntilEndBtn);
            videoDurationRow.append(videoLabel, videoInputContainer);
            
            // Hide Cycler button - hides both UIs, resets media, leaves only minimal UI
            this.elements.hideAllBtn = this.createSTButton('Hide Cycler', 'media-cycler-hide-all', () => {
                // Stop cycling
                this.stopMediaCycling();
                if (this.state.fadeTimeout) {
                    clearTimeout(this.state.fadeTimeout);
                    this.state.fadeTimeout = null;
                }
                
                // Clear media container (black screen)
                if (this.elements.container) {
                    this.elements.container.innerHTML = '';
                }
                
                // Reset media state to initial
                this.state.currentMedia = null;
                this.state.nextMedia = null;
                this.state.currentIndex = 0;
                this.state.isTransitioning = false;
                this.state.mediaStartTime = null;
                this.state.isEnabled = false;
                
                // Hide both UIs
                this.state.isUIVisible = false;
                this.state.isMediaVisible = false;
                
                // Update visibility and show minimal UI
                this.updateUIVisibility();
                this.syncMediaVisibilityUI();
                this.updateEyeButtons();
            });
            this.elements.hideAllBtn.setAttribute('title', 'Hide cycler and reset to initial state');
            this.elements.hideAllBtn.style.width = '100%';
            this.elements.hideAllBtn.style.marginTop = '4px';
            
            // Default Settings button
            const defaultSettingsBtn = this.createSTButton('Default Settings', 'media-cycler-default-settings', () => {
                this.resetToDefaultSettings();
            });
            defaultSettingsBtn.setAttribute('title', 'Reset all settings to defaults (requires refresh)');
            defaultSettingsBtn.style.width = '100%';
            
            // Debug toggle button
            const debugToggleBtn = this.createSTButton(
                'Debug',
                'media-cycler-debug-toggle',
                () => {
                    this.state.debugEnabled = !this.state.debugEnabled;
                    this.saveSettings();
                    if (this.state.debugEnabled) {
                        debugToggleBtn.classList.add('toggle-active');
                    } else {
                        debugToggleBtn.classList.remove('toggle-active');
                    }
                    // Disable button after one toggle to prevent multiple toggles before refresh
                    debugToggleBtn.disabled = true;
                    this.showTooltipNotification('Please refresh the page for debug changes to take effect');
                }
            );
            debugToggleBtn.setAttribute('title', 'Toggle debug console logging (requires refresh)');
            debugToggleBtn.style.width = '100%';
            debugToggleBtn.style.marginTop = '4px';
            if (this.state.debugEnabled) {
                debugToggleBtn.classList.add('toggle-active');
            }
            
            settingsContainer.append(imageDurationRow, videoDurationRow, this.elements.hideAllBtn, defaultSettingsBtn, debugToggleBtn);
            settingsContent.append(settingsContainer);
            
            // Characters tab content
            const charactersContent = this.createElement('div', {
                className: 'media-cycler-tab-content',
                id: 'mediaCyclerCharactersContent'
            });
            
            // Compact characters container
            const charactersContainer = this.createElement('div', {
                style: 'display: flex; flex-direction: column; gap: 8px; width: 100%;'
            });
            
            // Character list container (at top - shows character name and file controls)
            const charListContainer = this.createElement('div', {
                className: 'media-cycler-character-list',
                id: 'mediaCyclerCharacterList'
            });
            
            // Compact button row
            const buttonRow = this.createElement('div', {
                style: 'display: flex; gap: 6px; width: 100%;'
            });
            const linkCharBtn = this.createSTButton('Link', 'media-cycler-link-char', async () => {
                await this.linkCurrentCharacter();
            });
            linkCharBtn.setAttribute('title', 'Link current character and create media list');
            this.elements.linkCharBtn = linkCharBtn;
            
            const refreshCharBtn = this.createSTButton('Refresh', 'media-cycler-refresh-char', async () => {
                // Store current state before detection
                const oldCharacterId = this.state.currentCharacterId;
                const oldCharacterName = this.state.currentCharacterName;
                
                // Detect current character (this will update state if character changed)
                const detected = await this.detectCurrentCharacter(false);
                
                // Check if character actually changed
                const characterChanged = oldCharacterId !== this.state.currentCharacterId || 
                                       oldCharacterName !== this.state.currentCharacterName;
                
                if (detected) {
                    if (characterChanged) {
                        // Character changed - detectCurrentCharacter already called updateActiveList()
                        // Just update UI indicators
                        this.showStatusMessage(`Detected: ${this.state.currentCharacterName}`);
                        this.updateListIndicators();
                        this.updateCharacterListUI();
                    } else {
                        // Same character - just update UI indicators in case they're out of sync
                        // Don't call updateActiveList() - it might stop/hide media unnecessarily
                        this.showStatusMessage(`Character unchanged: ${this.state.currentCharacterName}`);
                        this.updateListIndicators();
                        this.updateCharacterListUI();
                    }
                } else {
                    // Could not detect character
                    if (characterChanged) {
                        // Character was lost (had one, now don't) - detectCurrentCharacter already handled it
                        this.showStatusMessage('Character lost - no character detected');
                        this.updateListIndicators();
                        this.updateCharacterListUI();
                    } else {
                        // Still no character (no change) - just update UI, don't disturb current state
                        this.showStatusMessage('Could not detect character. Try selecting a character in SillyTavern first.');
                        this.updateListIndicators();
                        this.updateCharacterListUI();
                    }
                }
            });
            refreshCharBtn.setAttribute('title', 'Refresh/Detect current character');
            this.elements.refreshCharBtn = refreshCharBtn;
            buttonRow.append(linkCharBtn, refreshCharBtn); // Both buttons in buttonRow initially
            this.elements.charButtonRow = buttonRow;
            
            // Refresh button row - appears below character folder when folder exists
            const refreshRow = this.createElement('div', {
                style: 'display: none; flex-direction: column; gap: 8px; width: 100%;' // Hidden initially
            });
            this.elements.refreshRow = refreshRow;
            
            // Character-specific mode toggle - rectangular tactile button
            const charModeRow = this.createElement('div', {
                style: 'display: flex; flex-direction: column; gap: 8px; width: 100%;'
            });
            const charModeBtn = this.createSTButton('Char Mode', 'media-cycler-char-mode-toggle', async () => {
                this.state.isCharacterSpecificMode = !this.state.isCharacterSpecificMode;
                this.saveSettings();
                this.updateCharacterModeUI();
                if (this.elements.fallbackRow) {
                    this.elements.fallbackRow.style.display = this.state.isCharacterSpecificMode ? 'flex' : 'none';
                }
                if (this.elements.fallbackToggle) {
                    this.elements.fallbackToggle.disabled = !this.state.isCharacterSpecificMode;
                }
                if (this.elements.wipeAllRow) {
                    this.elements.wipeAllRow.style.display = this.state.isCharacterSpecificMode ? 'flex' : 'none';
                }
                await this.updateActiveList();
                this.updateCharacterListUI();
            });
            charModeBtn.setAttribute('title', 'Enable separate media lists for each character. When enabled, media automatically switches when you change characters.');
            charModeBtn.style.width = '100%';
            charModeBtn.style.padding = '8px 12px';
            charModeBtn.style.fontSize = '12px';
            charModeBtn.style.borderRadius = '6px';
            if (this.state.isCharacterSpecificMode) {
                charModeBtn.classList.add('toggle-active');
            }
            this.elements.charModeToggle = charModeBtn; // Keep reference name for compatibility
            charModeRow.append(charModeBtn);
            
            // Fallback to Home toggle - rectangular tactile button (only visible when character-specific mode is enabled)
            const fallbackRow = this.createElement('div', { 
                style: `display: ${this.state.isCharacterSpecificMode ? 'flex' : 'none'}; flex-direction: column; gap: 8px; width: 100%;`
            });
            this.elements.fallbackRow = fallbackRow;
            const fallbackBtn = this.createSTButton('Fallback', 'media-cycler-fallback-toggle', async () => {
                if (!this.state.isCharacterSpecificMode) return; // Prevent toggling when disabled
                
                // Check if character media is currently playing
                const isCharacterPlaying = this.state.activeListType === 'character' && 
                                         this.state.currentCharacterId &&
                                         this.state.characterLists.has(this.state.currentCharacterId) &&
                                         this.state.characterLists.get(this.state.currentCharacterId).metadata?.length > 0;
                
                this.state.fallbackToHome = !this.state.fallbackToHome;
                this.saveSettings();
                this.updateCharacterModeUI();
                
                // Only update active list if character media is not currently playing
                // If character has media and is playing, it should stay on character media
                // regardless of fallback setting
                if (!isCharacterPlaying) {
                    await this.updateActiveList();
                }
                this.updateCharacterListUI();
            });
            fallbackBtn.setAttribute('title', 'When enabled, use home list if current character has no media. Home tab remains accessible.');
            fallbackBtn.style.width = '100%';
            fallbackBtn.style.padding = '8px 12px';
            fallbackBtn.style.fontSize = '12px';
            fallbackBtn.style.borderRadius = '6px';
            if (this.state.fallbackToHome) {
                fallbackBtn.classList.add('toggle-active');
            }
            if (!this.state.isCharacterSpecificMode) {
                fallbackBtn.disabled = true;
            }
            this.elements.fallbackToggle = fallbackBtn; // Keep reference name for compatibility
            fallbackRow.append(fallbackBtn);
            
            // Wipe All button - red button to clear all character folders
            const wipeAllRow = this.createElement('div', {
                style: `display: ${this.state.isCharacterSpecificMode ? 'flex' : 'none'}; flex-direction: column; gap: 8px; width: 100%;`
            });
            this.elements.wipeAllRow = wipeAllRow;
            const wipeAllBtn = this.createSTButton('Wipe All', 'media-cycler-wipe-all', async () => {
                const characterCount = this.state.characterLists.size;
                if (characterCount === 0) {
                    this.showStatusMessage('No character folders to wipe');
                    return;
                }
                
                if (confirm(`Are you sure you want to delete ALL ${characterCount} character folder${characterCount === 1 ? '' : 's'}? This action cannot be undone.`)) {
                    await this.clearAllCharacterLists();
                    this.showStatusMessage(`Deleted all ${characterCount} character folder${characterCount === 1 ? '' : 's'}`);
                    this.updateCharacterListUI();
                    await this.updateActiveList();
                }
            });
            wipeAllBtn.setAttribute('title', 'Delete all character media folders. This action cannot be undone.');
            wipeAllBtn.style.width = '100%';
            wipeAllBtn.style.padding = '8px 12px';
            wipeAllBtn.style.fontSize = '12px';
            wipeAllBtn.style.borderRadius = '6px';
            wipeAllBtn.style.backgroundColor = '#d32f2f';
            wipeAllBtn.style.color = 'white';
            wipeAllBtn.style.border = '1px solid #b71c1c';
            wipeAllBtn.addEventListener('mouseenter', () => {
                wipeAllBtn.style.backgroundColor = '#c62828';
            });
            wipeAllBtn.addEventListener('mouseleave', () => {
                wipeAllBtn.style.backgroundColor = '#d32f2f';
            });
            this.elements.wipeAllBtn = wipeAllBtn;
            wipeAllRow.append(wipeAllBtn);
            
            // Assemble - refresh row appears between character folder and char mode
            charactersContainer.append(buttonRow, charListContainer, refreshRow, charModeRow, fallbackRow, wipeAllRow);
            charactersContent.append(charactersContainer);
            
            this.elements.charactersContent = charactersContent;
            // charModeToggle is already assigned above at line 1921 as charModeBtn
            this.elements.charListContainer = charListContainer;

            // Store tab content references
            this.elements.tabContents = {
                main: mainContent,
                settings: settingsContent,
                characters: charactersContent
            };
            
            // Add smooth scrolling with reduced scroll amount for tab content
            [mainContent, settingsContent, charactersContent].forEach(tabContent => {
                if (tabContent) {
                    tabContent.addEventListener('wheel', (e) => {
                        // Reduce scroll amount by 50% for smoother scrolling in small area
                        e.preventDefault();
                        const scrollAmount = e.deltaY * 0.5;
                        tabContent.scrollBy({
                            top: scrollAmount,
                            behavior: 'smooth'
                        });
                    }, { passive: false });
                }
            });
            
            // Add all tab contents to bottom half (initially hidden)
            this.elements.bottomHalf.append(mainContent, settingsContent, charactersContent);

            // File input (hidden)
            this.elements.fileInput = this.createElement('input', {
                type: 'file',
                multiple: true,
                accept: '.jpg,.jpeg,.png,.webp,.gif,.bmp,.mp4,.webm,.mov,.avi,.mkv'
            });
            this.elements.fileInput.style.display = 'none';
            this.elements.fileInput.addEventListener('change', this.handleFileSelection);

            document.body.append(
                this.elements.container,
                this.elements.controls,
                this.elements.fileInput
            );

            this.injectStyles();
            // Start hidden at ST load
            this.state.isUIVisible = false;
            this.state.isMediaVisible = false;
            // Initialize movable UI state (lock icon)
            this.updateMovableUI();
            // Create minimal UI (visible initially so user can click to show controls)
            this.createMinimalUI();
            // Update visibility - this will hide controls and show minimal UI
            this.updateUIVisibility();
            this.syncMediaVisibilityUI();
            this.updateEyeButtons();
        }

        createSection(title) {
            const section = this.createElement('div', { className: 'media-cycler-section' });
            const header = this.createElement('div', { className: 'media-cycler-section-header' });
            header.textContent = title;
            const content = this.createElement('div', { className: 'media-cycler-section-content' });
            section.append(header, content);
            return content; // Return content so buttons can be appended
        }

        createSettingRow(label, description, value, onChange, inputType = 'number', inputAttrs = {}) {
            const row = this.createElement('div', { className: 'media-cycler-setting-row' });
            const labelEl = this.createElement('label', { className: 'media-cycler-setting-label' });
            labelEl.textContent = label;
            const descEl = this.createElement('div', { className: 'media-cycler-setting-desc' });
            descEl.textContent = description;
            const inputContainer = this.createElement('div', { className: 'media-cycler-setting-input-container' });
            const input = this.createElement('input', {
                type: inputType,
                className: 'media-cycler-setting-input'
            });
            // Set value after setting attributes to ensure proper initialization
            Object.entries(inputAttrs).forEach(([key, val]) => input.setAttribute(key, val));
            // For range inputs, ensure value is properly set as a number
            if (inputType === 'range') {
                input.value = parseFloat(value) || 0;
            } else {
                input.value = value;
            }
            const valueDisplay = this.createElement('span', { className: 'media-cycler-setting-value' });
            valueDisplay.textContent = inputType === 'range' ? parseFloat(input.value).toFixed(1) : input.value;
            
            input.addEventListener('input', (e) => {
                const val = inputType === 'range' ? parseFloat(e.target.value) : parseInt(e.target.value);
                if (!isNaN(val)) {
                    // Clamp value to min/max if specified
                    const min = inputAttrs.min !== undefined ? parseFloat(inputAttrs.min) : -Infinity;
                    const max = inputAttrs.max !== undefined ? parseFloat(inputAttrs.max) : Infinity;
                    const clampedVal = Math.max(min, Math.min(max, val));
                    
                    // Update display with clamped value
                    valueDisplay.textContent = inputType === 'range' ? clampedVal.toFixed(1) : clampedVal;
                    
                    // Update input value if it was clamped
                    if (clampedVal !== val) {
                        input.value = clampedVal;
                    }
                    
                    // Call onChange with clamped value
                    onChange(clampedVal);
                }
            });
            
            // Also validate on blur to catch manual edits
            input.addEventListener('blur', (e) => {
                const val = inputType === 'range' ? parseFloat(e.target.value) : parseInt(e.target.value);
                if (!isNaN(val)) {
                    const min = inputAttrs.min !== undefined ? parseFloat(inputAttrs.min) : -Infinity;
                    const max = inputAttrs.max !== undefined ? parseFloat(inputAttrs.max) : Infinity;
                    const clampedVal = Math.max(min, Math.min(max, val));
                    input.value = clampedVal;
                    valueDisplay.textContent = inputType === 'range' ? clampedVal.toFixed(1) : clampedVal;
                    onChange(clampedVal);
                }
            });
            
            inputContainer.append(input, valueDisplay);
            row.append(labelEl, descEl, inputContainer);
            return row;
        }

        switchTab(tabName) {
            // Remove active class from all tabs
            Object.values(this.elements.tabs).forEach(tab => tab.classList.remove('active'));
            
            // Hide quick actions and all tab contents
            if (this.elements.quickActions) {
                this.elements.quickActions.classList.remove('active');
            }
            if (this.elements.tabContents) {
                Object.values(this.elements.tabContents).forEach(content => {
                    if (content) content.classList.remove('active');
                });
            }
            
            // Activate selected tab and show appropriate content
            if (tabName === 'controls') {
                this.elements.tabs.controlsTab.classList.add('active');
                if (this.elements.quickActions) {
                    this.elements.quickActions.classList.add('active');
                }
            } else if (tabName === 'home') {
                this.elements.tabs.mainTab.classList.add('active');
                if (this.elements.tabContents && this.elements.tabContents.main) {
                    this.elements.tabContents.main.classList.add('active');
                }
                // Update home list status when switching to home tab
                this.updateHomeListStatus();
            } else if (tabName === 'settings') {
                this.elements.tabs.settingsTab.classList.add('active');
                if (this.elements.tabContents && this.elements.tabContents.settings) {
                    this.elements.tabContents.settings.classList.add('active');
                }
            } else if (tabName === 'characters') {
                this.elements.tabs.charactersTab.classList.add('active');
                if (this.elements.tabContents && this.elements.tabContents.characters) {
                    this.elements.tabContents.characters.classList.add('active');
                }
                this.updateCharacterListUI();
            }
        }

        createElement(tag, attributes = {}) {
            const element = document.createElement(tag);
            Object.entries(attributes).forEach(([key, value]) => {
                if (key === 'style' && typeof value === 'string') {
                    element.style.cssText = value;
                } else if (key === 'className') {
                    element.className = value;
                } else if (key === 'textContent') {
                    element.textContent = value;
                } else {
                    element.setAttribute(key, value);
                }
            });
            return element;
        }

        createSTButton(text, className, onClick) {
            const button = this.createElement('button', {
                className: `menu-button media-cycler-btn ${className}`
            });
            button.textContent = text;
            // Prevent text selection and drag behavior (fixes white rectangle/circle issue)
            button.style.userSelect = 'none';
            button.style.webkitUserSelect = 'none';
            button.style.MozUserSelect = 'none';
            button.style.msUserSelect = 'none';
            button.draggable = false;
            // Prevent default drag behavior
            button.addEventListener('dragstart', (e) => e.preventDefault());
            // Prevent text selection on long press/hold
            button.addEventListener('selectstart', (e) => e.preventDefault());
            button.addEventListener('contextmenu', (e) => {
                // Prevent context menu on right-click (can cause selection issues)
                e.preventDefault();
            });
            button.addEventListener('click', onClick);
            return button;
        }

        injectStyles() {
            // Only inject styles if not already present
            if (document.getElementById('mediaCyclerStyles')) return;

            const styles = `
                .media-cycler-container {
                    position: fixed;
                    top: 0;
                    right: 0;
                    width: 20%;
                    height: 100%;
                    z-index: 9998;
                    overflow: visible;
                    background: transparent !important;
                    border-radius: 0;
                    box-shadow: none !important;
                    border: 1px solid transparent;
                    transition: border-color 0.2s ease;
                    resize: none; /* Only resizable when movable-enabled (handled by external CSS) */
                    min-width: 200px;
                    min-height: 200px;
                    max-width: 90vw;
                    max-height: 100vh;
                    pointer-events: none;
                }

                /* Circular container IS the controls - no separate wrapper */
                /* Override external CSS to ensure it's always circular */
                /* Note: Element is technically 280x280px square, but border-radius makes it appear circular */
                .media-cycler-circle-container.media-cycler-controls,
                .media-cycler-controls.media-cycler-circle-container {
                    position: fixed !important;
                    width: 280px !important; /* Fixed size - never resize */
                    height: 280px !important; /* Fixed size - never resize */
                    border-radius: 50% !important; /* Force circular visual appearance */
                    background: var(--media-cycler-bg, rgba(0,0,0,0.95)) !important;
                    border: 1px solid transparent !important;
                    transition: border-color 0.2s ease !important;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.8), 0 4px 16px rgba(0,0,0,0.6) !important;
                    padding: 0 !important;
                    color: var(--text-color, white) !important;
                    font-family: inherit !important;
                    font-size: 12px !important;
                    resize: none !important; /* Circle is never resizable, only movable */
                    z-index: 10000 !important;
                    /* display is controlled by JavaScript - don't force it here */
                    flex-direction: column !important;
                    align-items: center !important;
                    gap: 0 !important;
                    pointer-events: auto !important;
                    overflow: visible !important; /* Allow tabs to extend beyond circle bounds */
                    resize: none !important; /* Never allow resize - circle is fixed size */
                    min-width: 280px !important;
                    min-height: 280px !important;
                    max-width: 280px !important;
                    max-height: 280px !important;
                    /* Don't set z-index on children - let them control stacking */
                    /* Element appears circular due to border-radius, but bounding box is square (normal) */
                }
                
                /* Ensure background never changes on hover - prevent white boxes */
                .media-cycler-circle-container:hover,
                .media-cycler-circle-container.media-cycler-controls:hover,
                .media-cycler-controls.media-cycler-circle-container:hover {
                    background: var(--media-cycler-bg, rgba(0,0,0,0.95)) !important;
                }
                
                /* Hover border effect for circle when movable - green like media UI */
                .media-cycler-circle-container.movable-enabled.show-hover-border,
                .media-cycler-controls.movable-enabled.show-hover-border {
                    border-color: rgba(76, 175, 80, 0.8) !important;
                    box-shadow: 0 4px 20px rgba(76, 175, 80, 0.3) !important;
                }
                
                /* Hover border effect for media container when movable - green like circle */
                .media-cycler-container.movable-enabled:hover {
                    border-color: rgba(76, 175, 80, 0.8) !important;
                    box-shadow: 0 4px 20px rgba(76, 175, 80, 0.3) !important;
                }
                
                /* Tabs should be hidden where they go under the circle */
                /* The circle halves (z-index: 100) should cover tabs (z-index: -1) */
                /* We'll ensure the circle halves extend properly to cover tabs */

                /* Top half - rectangular info section, smaller portion of circle */
                /* Circle: center (140, 140), radius 140px, cut at y=126px (45% of 280px) */
                /* Maximum rectangle in top half-circle: width limited by circle boundaries */
                /* At top (y=0): width = 0, at cut (y=126): width = 2*sqrt(140² - 14²) ≈ 278.6px */
                /* Maximum width occurs at the cut line, but must fit at all y positions */
                /* Constrain to fit within circle at all points: max-width ≈ 260px */
                .media-cycler-top-half {
                    height: 81px !important; /* Fixed 30px height */
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: center;
                    padding: clamp(16px, 4%, 28px) clamp(20px, 6%, 36px) clamp(10px, 3%, 20px) clamp(20px, 6%, 36px);
                    position: relative;
                    box-sizing: border-box;
                    overflow: hidden;
                    /* No clipping - just constrain width to fit within half-circle */
                    border-radius: 0 !important;
                    z-index: 100 !important; /* High z-index to ensure circle halves appear above tabs */
                    background: transparent !important; /* Transparent - should blend with circle, not show as separate rectangle */
                    width: 213px !important; /* Maximum width that fits in top half-circle */
                    max-width: 260px !important;
                    margin: 0 auto !important; /* Center the rectangle */
                    top: 14px;
                }
                
                /* Ensure background stays transparent on hover */
                .media-cycler-top-half:hover {
                    background: transparent !important;
                }

                .media-cycler-top-info {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    width: 100%;
                    max-width: 100%;
                    justify-content: center;
                    align-items: center;
                    box-sizing: border-box;
                }

                /* Lock/eye buttons positioned at 2 o'clock outside the circle */
                .media-cycler-external-button {
                    position: absolute !important;
                    z-index: 10001 !important; /* Above everything */
                    width: 32px !important;
                    height: 32px !important;
                    min-width: 32px !important;
                    min-height: 32px !important;
                    padding: 0 !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    border-radius: 50% !important;
                    background: var(--media-cycler-bg, rgba(0,0,0,0.95)) !important;
                    border: 1px solid transparent !important; /* No white outline */
                    cursor: pointer !important;
                    pointer-events: auto !important;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.5) !important;
                    color: var(--text-color, white) !important;
                    transition: all 0.2s ease !important;
                    /* No transform on base - buttons are positioned using left/top directly */
                }
                
                /* Hover effect for eye/lock buttons - subtle background change only */
                .media-cycler-external-button:hover {
                    background: rgba(255,255,255,0.1) !important;
                }
                
                /* Position at 2 o'clock: angle = 60 degrees from top (clockwise) */
                /* Circle container is 280x280px, center is at (140, 140) relative to container */
                /* At 2 o'clock (60° from top, clockwise):
                 *   x offset from center = radius * sin(60°) = 140 * 0.866 = 121.24px to the right
                 *   y offset from center = -radius * cos(60°) = -140 * 0.5 = -70px (up)
                 *   So from container's top-left:
                 *     x = 140 + 121.24 = 261.24px from left
                 *     y = 140 - 70 = 70px from top
                 *   Using right positioning: right = 280 - 261.24 = 18.76px from right edge
                 * 
                 * To place buttons OUTSIDE the circle:
                 *   Button is 32px wide, so if we want it mostly outside (90% out, 10% in):
                 *   Button center should be at: 261.24 + (32 * 0.9) = 261.24 + 28.8 = 290px from left
                 *   Using right: right = 280 - 290 = -10px (negative = extends beyond container)
                 *   But we want it clearly outside, so let's use right: -20px to -30px
                 */
                /* Position using left instead of right for clarity */
                /* At 2 o'clock: 60° from top, clockwise */
                /* Circle container: 280px wide, center at 140px from left */
                /* Point on circle edge: x = 140 + 140*sin(60°) = 140 + 121.24 = 261.24px from left */
                /* Circle edge is at 261.24px, container edge is at 280px */
                /* To place button clearly OUTSIDE (90% out means button center should be well beyond edge) */
                /* Button is 32px wide, so if center is at 300px, left edge is at 284px (outside 280px container) */
                /* But we want it clearly visible outside, so let's use 310px for lock button */
                .media-cycler-lock-btn {
                    top: 55px !important; /* User-adjusted position */
                    left: 285px !important; /* User-adjusted position */
                    right: auto !important;
                    transform: translateX(-50%) !important; /* Center the button on the left position */
                }
                
                .media-cycler-eye-btn {
                    top: 25px !important; /* User-adjusted position */
                    left: 265px !important; /* User-adjusted position */
                    right: auto !important;
                    transform: translateX(-50%) !important; /* Center the button on the left position */
                }
                
                .media-cycler-storage-indicator {
                    top: -22px !important;
                    left: 213px !important;
                    right: auto !important;
                    transform: translateX(-50%) !important; /* Center the indicator on the left position */
                }
                
                .media-cycler-background-mode-btn {
                    top: -2px !important;
                    left: 242px !important;
                    right: auto !important;
                    transform: translateX(-50%) !important; /* Center the button on the left position */
                }

                /* Bottom half - rectangular content area, larger portion of circle */
                /* Circle: center (140, 140), radius 140px, cut at y=126px, extends to y=280px */
                /* Maximum rectangle in bottom half-circle: width limited by circle boundaries */
                /* Rectangle spans from y=126 to y=280 (full height of bottom half) */
                /* Narrowest point is at middle (y=203): width = 2*sqrt(140² - 63²) = 2*sqrt(19600-3969) = 2*sqrt(15631) ≈ 250px */
                /* Maximum width that fits at all points: 250px */
                .media-cycler-bottom-half {
                    /* CSS Variables for easy manual adjustment - inspect and modify these */
                    --bottom-half-width: 240px;
                    --bottom-half-max-width: 240px;
                    --bottom-half-top: 37%;
                    --bottom-half-height: 52%;
                    --bottom-half-border-radius: 63px;
                    --bottom-half-padding-top: 0px;
                    --bottom-half-padding-bottom: 0px;
                    --bottom-half-padding-left: 0px;
                    --bottom-half-padding-right: 0px;
                    
                    height: 53%; /* 154px - larger bottom portion */
                    padding: var(--bottom-half-padding-top) var(--bottom-half-padding-right) var(--bottom-half-padding-bottom) var(--bottom-half-padding-left);
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: center;
                    overflow-y: auto !important; /* Vertical scroll only if needed */
                    overflow-x: hidden !important; /* Never allow horizontal scroll */
                    box-sizing: border-box;
                    /* Electronic screen appearance - smooth rounded corners */
                    border-radius: var(--bottom-half-border-radius) !important;
                    border: 1px solid rgba(255, 255, 255, 0.15) !important;
                    /* Subtle shadow to make it pop off the circle */
                    box-shadow: 
                        0 2px 8px rgba(0, 0, 0, 0.4),
                        inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
                    /* Position to start at 45% from top (where top half ends) and extend to bottom */
                    position: absolute !important;
                    top: var(--bottom-half-top) !important;
                    left: 0 !important;
                    right: 0 !important;
                    bottom: 0 !important;
                    height: var(--bottom-half-height) !important;
                    z-index: 100 !important; /* High z-index to ensure circle halves appear above tabs */
                    /* Slightly different shade from circle - slightly lighter/darker to distinguish it */
                    background: var(--media-cycler-bg, rgba(0,0,0,0.95)) !important;
                    filter: brightness(1.05) !important; /* Slightly brighter to distinguish from circle */
                    width: var(--bottom-half-width) !important; /* Maximum width that fits in bottom half-circle (at narrowest point) */
                    max-width: var(--bottom-half-max-width) !important;
                    margin: 0 auto !important; /* Center the rectangle */
                }
                
                /* Ensure background never changes on hover - prevent white boxes */
                .media-cycler-bottom-half:hover {
                    background: var(--media-cycler-bg, rgba(0,0,0,0.95)) !important;
                    filter: brightness(1.05) !important; /* Maintain shade on hover */
                }

                /* Quick actions - Spotify style */
                .media-cycler-quick-actions {
                    display: none;
                    flex-direction: column;
                    gap: 0.75em;
                    width: 100%;
                    max-width: 100%;
                    align-items: center;
                    justify-content: center;
                    box-sizing: border-box;
                }

                .media-cycler-quick-actions.active {
                    display: flex;
                }
                
                /* Tab content containers */
                .media-cycler-tab-content {
                    width: 100%;
                    max-width: 100%;
                    height: 100%;
                    overflow-y: auto;
                    overflow-x: hidden;
                    box-sizing: border-box;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: flex-start;
                    padding: 0;
                    scroll-behavior: smooth;
                }

                .media-cycler-controls-row {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.75em;
                    width: 100%;
                }

                .media-cycler-controls-bottom {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 1em;
                    width: 100%;
                    margin-top: 0.75em;
                }

                .media-cycler-quick-action {
                    width: 3.5em;
                    height: 3.5em;
                    min-width: 3.5em;
                    min-height: 3.5em;
                    padding: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 50%;
                    background: transparent;
                    color: var(--text-color, rgba(255,255,255,0.9));
                    box-shadow: none;
                    margin: 0;
                    font-size: inherit;
                    position: relative;
                    z-index: 101; /* Above the half elements (z-index 100) */
                }

                .media-cycler-quick-action svg {
                    width: 1.75em;
                    height: 1.75em;
                    color: currentColor;
                }

                .media-cycler-quick-action:hover {
                    background: var(--bg-elevated, rgba(255,255,255,0.1));
                    transform: scale(1.1);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                }

                .media-cycler-quick-action:active {
                    transform: scale(0.95);
                }

                /* Previous and Next buttons - tactile raised effect matching shuffle */
                .media-cycler-prev,
                .media-cycler-next {
                    transition: all 0.2s ease !important;
                    box-shadow: 
                        -2px -2px 4px rgba(255,255,255,0.1),
                        2px 2px 4px rgba(0,0,0,0.3),
                        0 0 0 1px rgba(255,255,255,0.05) inset !important;
                    background: transparent !important;
                    border: none !important;
                    transform: translateY(-1px) !important;
                }

                .media-cycler-prev:hover,
                .media-cycler-next:hover {
                    transform: translateY(-1px) scale(1.1) !important;
                    box-shadow: 
                        -3px -3px 6px rgba(255,255,255,0.15),
                        3px 3px 6px rgba(0,0,0,0.4),
                        0 0 0 1px rgba(255,255,255,0.08) inset !important;
                    background: var(--bg-elevated, rgba(255,255,255,0.1)) !important;
                }

                .media-cycler-prev:active,
                .media-cycler-next:active {
                    transform: translateY(0px) scale(0.95) !important;
                    box-shadow: 
                        0 1px 2px rgba(0,0,0,0.4) inset,
                        0 -1px 1px rgba(255,255,255,0.05) inset,
                        0 0 0 1px rgba(0,0,0,0.2) inset !important;
                }

                /* Shuffle button - tactile toggle effect */
                .media-cycler-shuffle {
                    transition: all 0.2s ease !important;
                }

                /* Shuffle OFF - raised/pressed outward effect, same color as prev/next */
                .media-cycler-shuffle:not(.shuffle-active) {
                    box-shadow: 
                        -2px -2px 4px rgba(255,255,255,0.1),
                        2px 2px 4px rgba(0,0,0,0.3),
                        0 0 0 1px rgba(255,255,255,0.05) inset !important;
                    background: transparent !important;
                    border: none !important;
                    transform: translateY(-1px) !important;
                }

                /* Shuffle ON - pressed inward effect */
                .media-cycler-shuffle.shuffle-active {
                    box-shadow: 
                        0 1px 2px rgba(0,0,0,0.4) inset,
                        0 -1px 1px rgba(255,255,255,0.05) inset,
                        0 0 0 1px rgba(0,0,0,0.2) inset !important;
                    background: var(--bg-elevated, rgba(0,0,0,0.2)) !important;
                    transform: translateY(1px) !important;
                    border: 1px solid rgba(255,255,255,0.15) !important;
                }

                .media-cycler-shuffle:hover:not(.shuffle-active) {
                    transform: translateY(-1px) scale(1.1) !important;
                    box-shadow: 
                        -3px -3px 6px rgba(255,255,255,0.15),
                        3px 3px 6px rgba(0,0,0,0.4),
                        0 0 0 1px rgba(255,255,255,0.08) inset !important;
                    background: var(--bg-elevated, rgba(255,255,255,0.1)) !important;
                }

                .media-cycler-shuffle:hover.shuffle-active {
                    transform: translateY(1px) scale(1.05) !important;
                    box-shadow: 
                        0 2px 3px rgba(0,0,0,0.5) inset,
                        0 -1px 2px rgba(255,255,255,0.08) inset,
                        0 0 0 1px rgba(0,0,0,0.3) inset !important;
                }

                /* Char Mode and Fallback toggle buttons - rectangular tactile toggle */
                .media-cycler-char-mode-toggle,
                .media-cycler-fallback-toggle {
                    transition: all 0.2s ease !important;
                    border-radius: 6px !important;
                    font-weight: 500 !important;
                }

                /* Toggle OFF - raised/pressed outward effect */
                .media-cycler-char-mode-toggle:not(.toggle-active),
                .media-cycler-fallback-toggle:not(.toggle-active) {
                    box-shadow: 
                        -2px -2px 4px rgba(255,255,255,0.1),
                        2px 2px 4px rgba(0,0,0,0.3),
                        0 0 0 1px rgba(255,255,255,0.05) inset !important;
                    background: var(--bg-elevated, rgba(255,255,255,0.08)) !important;
                    border: 1px solid rgba(255,255,255,0.1) !important;
                    transform: translateY(-1px) !important;
                }

                /* Toggle ON - pressed inward effect */
                .media-cycler-char-mode-toggle.toggle-active,
                .media-cycler-fallback-toggle.toggle-active {
                    box-shadow: 
                        0 1px 2px rgba(0,0,0,0.4) inset,
                        0 -1px 1px rgba(255,255,255,0.05) inset,
                        0 0 0 1px rgba(0,0,0,0.2) inset !important;
                    background: var(--bg-elevated, rgba(0,0,0,0.2)) !important;
                    border: 1px solid rgba(255,255,255,0.15) !important;
                    transform: translateY(1px) !important;
                }

                .media-cycler-char-mode-toggle:hover:not(.toggle-active),
                .media-cycler-fallback-toggle:hover:not(.toggle-active) {
                    transform: translateY(-1px) scale(1.02) !important;
                    box-shadow: 
                        -3px -3px 6px rgba(255,255,255,0.15),
                        3px 3px 6px rgba(0,0,0,0.4),
                        0 0 0 1px rgba(255,255,255,0.08) inset !important;
                }

                .media-cycler-char-mode-toggle:hover.toggle-active,
                .media-cycler-fallback-toggle:hover.toggle-active {
                    transform: translateY(1px) scale(1.02) !important;
                    box-shadow: 
                        0 2px 3px rgba(0,0,0,0.5) inset,
                        0 -1px 2px rgba(255,255,255,0.08) inset,
                        0 0 0 1px rgba(0,0,0,0.3) inset !important;
                }

                .media-cycler-char-mode-toggle:disabled,
                .media-cycler-fallback-toggle:disabled {
                    opacity: 0.5 !important;
                    cursor: not-allowed !important;
                    transform: none !important;
                }

                /* Debug toggle button - rectangular tactile toggle */
                .media-cycler-debug-toggle {
                    transition: all 0.2s ease !important;
                    border-radius: 6px !important;
                    font-weight: 500 !important;
                }

                /* Toggle OFF - raised/pressed outward effect */
                .media-cycler-debug-toggle:not(.toggle-active) {
                    box-shadow: 
                        -2px -2px 4px rgba(255,255,255,0.1),
                        2px 2px 4px rgba(0,0,0,0.3),
                        0 0 0 1px rgba(255,255,255,0.05) inset !important;
                    background: var(--bg-elevated, rgba(255,255,255,0.08)) !important;
                    border: 1px solid rgba(255,255,255,0.1) !important;
                    transform: translateY(-1px) !important;
                }

                /* Toggle ON - pressed inward effect */
                .media-cycler-debug-toggle.toggle-active {
                    box-shadow: 
                        0 1px 2px rgba(0,0,0,0.4) inset,
                        0 -1px 1px rgba(255,255,255,0.05) inset,
                        0 0 0 1px rgba(0,0,0,0.2) inset !important;
                    background: var(--bg-elevated, rgba(0,0,0,0.2)) !important;
                    border: 1px solid rgba(255,255,255,0.15) !important;
                    transform: translateY(1px) !important;
                }

                .media-cycler-debug-toggle:hover:not(.toggle-active):not(:disabled) {
                    transform: translateY(-1px) scale(1.02) !important;
                    box-shadow: 
                        -3px -3px 6px rgba(255,255,255,0.15),
                        3px 3px 6px rgba(0,0,0,0.4),
                        0 0 0 1px rgba(255,255,255,0.08) inset !important;
                }

                .media-cycler-debug-toggle:hover.toggle-active:not(:disabled) {
                    transform: translateY(1px) scale(1.02) !important;
                    box-shadow: 
                        0 2px 3px rgba(0,0,0,0.5) inset,
                        0 -1px 2px rgba(255,255,255,0.08) inset,
                        0 0 0 1px rgba(0,0,0,0.3) inset !important;
                }

                .media-cycler-debug-toggle:disabled {
                    opacity: 0.5 !important;
                    cursor: not-allowed !important;
                    transform: none !important;
                }

                /* Play until end icon button - tactile toggle */
                .media-cycler-play-until-end {
                    transition: all 0.2s ease !important;
                }

                .media-cycler-play-until-end:not(.toggle-active) {
                    box-shadow: 
                        -1px -1px 2px rgba(255,255,255,0.1),
                        1px 1px 2px rgba(0,0,0,0.3),
                        0 0 0 1px rgba(255,255,255,0.05) inset !important;
                    background: var(--bg-elevated, rgba(255,255,255,0.08)) !important;
                    border: 1px solid rgba(255,255,255,0.1) !important;
                }

                .media-cycler-play-until-end.toggle-active {
                    box-shadow: 
                        0 1px 2px rgba(0,0,0,0.4) inset,
                        0 -1px 1px rgba(255,255,255,0.05) inset,
                        0 0 0 1px rgba(0,0,0,0.2) inset !important;
                    background: var(--bg-elevated, rgba(0,0,0,0.2)) !important;
                    border: 1px solid rgba(255,255,255,0.15) !important;
                }

                .media-cycler-play-until-end:hover:not(.toggle-active) {
                    box-shadow: 
                        -2px -2px 4px rgba(255,255,255,0.15),
                        2px 2px 4px rgba(0,0,0,0.4),
                        0 0 0 1px rgba(255,255,255,0.08) inset !important;
                }

                .media-cycler-play-until-end:hover.toggle-active {
                    box-shadow: 
                        0 2px 3px rgba(0,0,0,0.5) inset,
                        0 -1px 2px rgba(255,255,255,0.08) inset,
                        0 0 0 1px rgba(0,0,0,0.3) inset !important;
                }

                /* Hide number input spinners */
                input[type="text"][inputmode="numeric"]::-webkit-inner-spin-button,
                input[type="text"][inputmode="numeric"]::-webkit-outer-spin-button {
                    -webkit-appearance: none;
                    margin: 0;
                }
                input[type="text"][inputmode="numeric"] {
                    -moz-appearance: textfield;
                }

                .media-cycler-play-btn {
                    width: 4.5em !important;
                    height: 4.5em !important;
                    min-width: 4.5em !important;
                    min-height: 4.5em !important;
                    background: transparent !important; /* Not lit up by default */
                    color: var(--text-color, rgba(255,255,255,0.9)) !important;
                }
                
                /* Only lit up when playing */
                .media-cycler-play-btn.playing {
                    /* Background and glow will be set dynamically via JavaScript */
                    color: var(--text-color, rgba(255,255,255,0.9)) !important;
                }

                .media-cycler-play-btn:hover {
                    transform: scale(1.05);
                }
                
                .media-cycler-play-btn.playing:hover {
                    /* Hover state will be handled dynamically */
                }

                .media-cycler-play-btn svg {
                    width: 2.25em;
                    height: 2.25em;
                    color: currentColor;
                }

                .media-cycler-volume-quick {
                    display: flex;
                    align-items: center;
                    gap: 0.5em;
                    width: auto;
                    max-width: 11.25em;
                }

                .media-cycler-volume-icon {
                    width: 1.5em;
                    height: 1.5em;
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--text-color, rgba(255,255,255,0.9));
                }

                .media-cycler-volume-icon svg {
                    width: 100%;
                    height: 100%;
                    color: currentColor;
                }

                .media-cycler-volume-slider {
                    width: 8em;
                    height: 0.375em;
                    cursor: pointer;
                    background: var(--bg-elevated, rgba(255,255,255,0.2));
                    border-radius: 0.1875em;
                    outline: none;
                    -webkit-appearance: none;
                    accent-color: var(--text-color, rgba(255,255,255,0.9));
                    color: var(--text-color, rgba(255,255,255,0.9));
                }

                .media-cycler-volume-slider::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 1em;
                    height: 1em;
                    border-radius: 50%;
                    background: var(--text-color, rgba(255,255,255,0.9));
                    cursor: pointer;
                }

                .media-cycler-volume-slider::-moz-range-thumb {
                    width: 1em;
                    height: 1em;
                    border-radius: 50%;
                    background: var(--text-color, rgba(255,255,255,0.9));
                    cursor: pointer;
                    border: none;
                }

                /* Tab icon buttons - styled like eye/lock buttons */
                .media-cycler-tab-btn {
                    position: absolute !important;
                    z-index: 10001 !important; /* Above everything, same as eye/lock buttons */
                    width: 32px !important;
                    height: 32px !important;
                    min-width: 32px !important;
                    min-height: 32px !important;
                    padding: 0 !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    border-radius: 50% !important;
                    background: var(--media-cycler-bg, rgba(0,0,0,0.95)) !important;
                    border: 1px solid transparent !important; /* No white outline */
                    cursor: pointer !important;
                    pointer-events: auto !important;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.5) !important;
                    color: var(--text-color, white) !important;
                    transition: all 0.2s ease !important;
                }
                
                .media-cycler-tab-btn svg {
                    width: 20px !important;
                    height: 20px !important;
                    stroke: currentColor !important;
                    fill: none !important;
                }
                
                /* Hover effect for tab buttons - subtle background change only */
                .media-cycler-tab-btn:hover {
                    background: rgba(255,255,255,0.1) !important;
                    transform: translateY(-0.125em) !important;
                }

                .media-cycler-tab-btn.active {
                    background: rgba(255,255,255,0.15) !important;
                    border-color: rgba(255,255,255,0.5) !important;
                    box-shadow: 0 0 0 1px rgba(255,255,255,0.3), 0 2px 8px rgba(0,0,0,0.3) !important;
                    transform: scale(1.05) !important;
                }
                
                .media-cycler-tab-btn.active svg {
                    stroke: currentColor !important;
                    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5)) !important;
                }
                
                .media-cycler-tab-btn.active:hover {
                    transform: scale(1.1) translateY(-0.125em) !important;
                }
                
                .media-cycler-tab-btn:active {
                    transform: scale(1.05) translateY(0) !important;
                    box-shadow: 0 0.0625em 0.125em rgba(0,0,0,0.2) !important;
                }
                
                .media-cycler-tab-btn.active:active {
                    transform: scale(1.05) translateY(0) !important;
                }

                /* Tab content in bottom half - extra padding to prevent cut-off */
                .media-cycler-tab-content {
                    display: none;
                    width: 80%;
                    height: 100%;
                    overflow-y: auto;
                    overflow-x: hidden;
                    padding: clamp(8px, 2.5%, 16px) clamp(16px, 5%, 32px) clamp(24px, 8%, 40px) clamp(16px, 5%, 32px);
                    box-sizing: border-box;
                }

                .media-cycler-tab-content.active {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5em;
                }

                .media-cycler-circle-container.movable-enabled {
                    cursor: move !important;
                    /* Override external CSS - prevent resize and overflow changes */
                    resize: none !important;
                    overflow: visible !important;
                    width: 280px !important;
                    height: 280px !important;
                    min-width: 280px !important;
                    min-height: 280px !important;
                    max-width: 280px !important;
                    max-height: 280px !important;
                }

                .media-cycler-circle-container.movable-dragging {
                    z-index: 10001 !important;
                    box-shadow: 0 12px 40px rgba(76, 175, 80, 0.5) !important;
                    opacity: 0.95;
                    /* Keep fixed size even when dragging */
                    resize: none !important;
                    overflow: visible !important;
                    width: 280px !important;
                    height: 280px !important;
                }

                .media-cycler-container img,
                .media-cycler-container video {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    object-fit: contain;
                    transition: opacity ${CONFIG.FADE_DURATION}ms ease-in-out;
                    pointer-events: none !important;
                    user-select: none !important;
                    -webkit-user-drag: none !important;
                }

                .media-cycler-active-indicator {
                    font-size: 1em;
                    font-weight: 600;
                    color: var(--accent-color, #4CAF50);
                    text-align: center;
                    width: 100%;
                    max-width: 100%;
                    overflow: hidden;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                    /* Horizontal scrolling for long text */
                    overflow-x: auto;
                    overflow-y: hidden;
                    scrollbar-width: none; /* Firefox */
                    -ms-overflow-style: none; /* IE/Edge */
                }
                
                .media-cycler-active-indicator::-webkit-scrollbar {
                    display: none; /* Chrome/Safari */
                }

                .media-cycler-character-indicator {
                    font-size: 0.83em;
                    color: var(--text-color, rgba(255,255,255,0.6));
                    font-style: italic;
                    text-align: center;
                    width: 100%;
                    max-width: 100%;
                    overflow: hidden;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                    /* Horizontal scrolling for long text */
                    overflow-x: auto;
                    overflow-y: hidden;
                    scrollbar-width: none; /* Firefox */
                    -ms-overflow-style: none; /* IE/Edge */
                }
                
                .media-cycler-character-indicator::-webkit-scrollbar {
                    display: none; /* Chrome/Safari */
                }

                .media-cycler-file-count {
                    font-weight: 600;
                    font-size: 0.92em;
                    color: var(--text-color, rgba(255,255,255,0.8));
                    text-align: center;
                    margin-top: 0.33em;
                    width: 100%;
                    max-width: 100%;
                    overflow: hidden;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                }

                .media-cycler-status {
                    font-size: 0.83em;
                    opacity: 0.8;
                    text-align: center;
                    margin-top: 0.17em;
                    color: var(--text-color, rgba(255,255,255,0.7));
                    width: 100%;
                    max-width: 100%;
                    overflow: hidden;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                }

                /* Section styling - scales with container */
                .media-cycler-section {
                    margin-bottom: 1em;
                }

                .media-cycler-section-header {
                    font-size: 0.92em;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--text-color, rgba(255,255,255,0.7));
                    margin-bottom: 0.5em;
                    padding-bottom: 0.25em;
                    border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.1));
                }

                .media-cycler-section-content {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.375em;
                    min-width: 0; /* Allow shrinking below content size */
                    overflow-x: auto; /* Allow horizontal scrolling if needed */
                    overflow-y: visible;
                    padding: 0.125em; /* Add padding to prevent button cut-off on hover */
                }

                .media-cycler-button-group {
                    display: flex;
                    gap: 0.375em;
                    flex-wrap: wrap;
                    min-width: 0; /* Allow shrinking below content size */
                    overflow-x: auto; /* Allow horizontal scrolling if needed */
                    overflow-y: visible;
                    padding: 0.125em; /* Add padding to prevent button cut-off on hover */
                }

                /* Material Design Button Style - Applied to all buttons */
                .media-cycler-btn {
                    padding: 10px 20px;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 600;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    box-shadow: 0 2px 6px rgba(0,0,0,0.25), 0 1px 3px rgba(0,0,0,0.15);
                    background: var(--bg-elevated, rgba(255,255,255,0.1));
                    color: var(--text-color, rgba(255,255,255,0.95));
                    position: relative;
                    overflow: visible;
                    flex-shrink: 0;
                    white-space: nowrap;
                    margin: 2px;
                    will-change: transform, box-shadow;
                }

                .media-cycler-btn:not(.media-cycler-quick-action):hover {
                    box-shadow: 0 6px 12px rgba(0,0,0,0.4), 0 3px 6px rgba(0,0,0,0.25);
                    transform: translateY(-3px);
                    background: var(--bg-elevated, rgba(255,255,255,0.15));
                }

                .media-cycler-btn:not(.media-cycler-quick-action):active {
                    transform: translateY(-1px);
                    box-shadow: 0 2px 4px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2);
                    transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
                }

                .media-cycler-btn:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                    transform: none;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                }

                .media-cycler-btn:disabled:hover {
                    transform: none;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                }

                /* Primary action buttons - use accent color when active/playing */
                .media-cycler-toggle.playing {
                    background: rgba(76, 175, 80, 0.25);
                    color: #66BB6A;
                    box-shadow: 0 3px 8px rgba(76, 175, 80, 0.35), 0 2px 4px rgba(76, 175, 80, 0.2);
                }

                .media-cycler-toggle.playing:hover {
                    background: rgba(76, 175, 80, 0.35);
                    color: #81C784;
                    box-shadow: 0 6px 14px rgba(76, 175, 80, 0.45), 0 3px 6px rgba(76, 175, 80, 0.3);
                }

                /* Icon buttons - same size as forward/reverse buttons */
                /* CSS Variable: --icon-btn-size (default: 3.5em) - Edit in inspector to adjust button size */
                .media-cycler-icon-btn {
                    --icon-btn-size: 5.5em;
                    width: var(--icon-btn-size) !important;
                    height: var(--icon-btn-size) !important;
                    min-width: var(--icon-btn-size) !important;
                    min-height: var(--icon-btn-size) !important;
                    padding: 0 !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    border-radius: 50% !important;
                    background: transparent !important;
                    color: var(--text-color, rgba(255,255,255,0.9)) !important;
                    box-shadow: none !important;
                    transition: all 0.2s ease !important;
                }

                .media-cycler-icon-btn svg {
                    width: calc(var(--icon-btn-size) * 0.5);
                    height: calc(var(--icon-btn-size) * 0.5);
                    stroke: currentColor;
                    fill: none;
                }

                .media-cycler-icon-btn:hover {
                    background: var(--bg-elevated, rgba(255,255,255,0.1)) !important;
                    transform: scale(1.1);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;
                }

                .media-cycler-icon-btn:active {
                    transform: scale(0.95);
                }

                /* Primary action buttons - Add buttons use subtle accent (for character sections) */
                .media-cycler-char-add,
                .media-cycler-link-char {
                    background: rgba(76, 175, 80, 0.15);
                    color: #66BB6A;
                    box-shadow: 0 2px 6px rgba(76, 175, 80, 0.25), 0 1px 3px rgba(76, 175, 80, 0.15);
                }

                .media-cycler-char-add:hover,
                .media-cycler-link-char:hover {
                    background: rgba(76, 175, 80, 0.25);
                    color: #81C784;
                    box-shadow: 0 6px 12px rgba(76, 175, 80, 0.35), 0 3px 6px rgba(76, 175, 80, 0.25);
                }

                /* Destructive actions - red color (for character sections) */
                .media-cycler-char-clear,
                .media-cycler-char-delete {
                    background: rgba(255, 87, 87, 0.2);
                    color: #FF6B6B;
                    box-shadow: 0 2px 6px rgba(255, 87, 87, 0.3), 0 1px 3px rgba(255, 87, 87, 0.2);
                }

                .media-cycler-char-clear:hover,
                .media-cycler-char-delete:hover {
                    background: rgba(255, 87, 87, 0.3);
                    color: #FF8A8A;
                    box-shadow: 0 6px 12px rgba(255, 87, 87, 0.4), 0 3px 6px rgba(255, 87, 87, 0.3);
                }

                /* Eye and lock buttons - special styling for circular layout - scales with container */
                .media-cycler-eye-btn,
                .media-cycler-lock-btn,
                .media-cycler-storage-indicator {
                    font-size: 1.5em;
                    padding: 0;
                    line-height: 1;
                    min-width: auto;
                    border-radius: 50%;
                    width: 2em;
                    height: 2em;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: var(--bg-elevated, rgba(255,255,255,0.08)) !important;
                    color: var(--text-color, inherit) !important;
                    box-shadow: 0 0.125em 0.25em rgba(0,0,0,0.2), 0 0.0625em 0.125em rgba(0,0,0,0.1) !important;
                    margin: 0;
                }
                
                .media-cycler-storage-indicator {
                    pointer-events: none;
                    cursor: default;
                }
                
                .media-cycler-storage-indicator .storage-progress-circle {
                    transition: stroke-dasharray 0.3s ease, stroke 0.3s ease;
                }

                .media-cycler-external-button:hover {
                    background: rgba(255,255,255,0.2) !important;
                    /* Preserve translateX(-50%) if present, add translateY for lift effect */
                    box-shadow: 0 0.25em 0.5em rgba(0,0,0,0.3), 0 0.125em 0.25em rgba(0,0,0,0.2) !important;
                }
                
                /* Lock and eye buttons have translateX(-50%) for centering - preserve it on hover */
                .media-cycler-lock-btn:hover,
                .media-cycler-eye-btn:hover,
                .media-cycler-background-mode-btn:hover {
                    transform: translateX(-50%) translateY(-0.125em) !important;
                }
                
                .media-cycler-storage-indicator:hover {
                    transform: translateX(-50%) !important; /* Preserve centering on hover - no lift effect (informational only) */
                }
                
                .media-cycler-external-button:active {
                    box-shadow: 0 0.0625em 0.125em rgba(0,0,0,0.2) !important;
                }
                
                .media-cycler-lock-btn:active,
                .media-cycler-eye-btn:active,
                .media-cycler-background-mode-btn:active {
                    transform: translateX(-50%) translateY(0) !important;
                }
                
                .media-cycler-storage-indicator:active {
                    transform: translateX(-50%) !important; /* Preserve centering on active */
                }

                .media-cycler-show-all-btn {
                    background: var(--bg-elevated, rgba(255,255,255,0.08)) !important;
                    color: var(--text-color, inherit) !important;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.2), 0 1px 2px rgba(0,0,0,0.1) !important;
                }

                .media-cycler-show-all-btn:hover {
                    box-shadow: 0 4px 8px rgba(0,0,0,0.3), 0 2px 4px rgba(0,0,0,0.2) !important;
                    transform: translateY(-2px) !important;
                    background: var(--bg-elevated, rgba(255,255,255,0.12)) !important;
                }

                .media-cycler-show-all-btn:active {
                    transform: translateY(0) !important;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.2) !important;
                }

                /* Settings styling - compact for circular layout - scales with container */
                .media-cycler-setting-row {
                    margin-bottom: 0.625em;
                    padding: 0.625em;
                    background: var(--bg-primary, rgba(255,255,255,0.03));
                    border-radius: 0.375em;
                    border: 1px solid var(--border-color, rgba(255,255,255,0.1));
                }

                .media-cycler-setting-label {
                    display: block;
                    font-weight: 600;
                    font-size: 1em;
                    margin-bottom: 0.25em;
                    color: var(--text-color, inherit);
                }

                .media-cycler-setting-desc {
                    font-size: 0.83em;
                    color: var(--text-color, rgba(255,255,255,0.6));
                    margin-bottom: 0.5em;
                }

                .media-cycler-setting-input-container {
                    display: flex;
                    align-items: center;
                    gap: 0.5em;
                }

                .media-cycler-setting-input {
                    flex: 1;
                    padding: 0.375em;
                    background: var(--bg-elevated, rgba(0,0,0,0.3));
                    border: 1px solid var(--border-color, rgba(255,255,255,0.2));
                    border-radius: 0.25em;
                    color: var(--text-color, inherit);
                    font-size: 1em;
                }

                .media-cycler-setting-input[type="range"] {
                    padding: 0;
                    height: 0.375em;
                    cursor: pointer;
                }

                .media-cycler-setting-value {
                    display: inline-block;
                    min-width: 3.125em;
                    font-weight: 600;
                    color: var(--accent-color, #4CAF50);
                    font-size: 1em;
                    text-align: right;
                }

                /* Toggle styling - Material Design switch */
                .media-cycler-toggle-label-inline {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    cursor: pointer;
                    user-select: none;
                }

                .media-cycler-toggle-switch {
                    position: relative;
                    width: 40px;
                    height: 20px;
                    appearance: none;
                    background: rgba(255,255,255,0.2);
                    border-radius: 10px;
                    outline: none;
                    cursor: pointer;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    flex-shrink: 0;
                }

                .media-cycler-toggle-switch::before {
                    content: '';
                    position: absolute;
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    top: 2px;
                    left: 2px;
                    background: white;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                }

                .media-cycler-toggle-switch:checked {
                    background: var(--accent-color, #4CAF50);
                }

                .media-cycler-toggle-switch:checked::before {
                    transform: translateX(20px);
                }

                .media-cycler-toggle-switch:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                .media-cycler-setting-input:disabled {
                    cursor: not-allowed;
                    opacity: 0.5;
                }
            `;

            const styleElement = this.createElement('style', { id: 'mediaCyclerStyles' });
            styleElement.textContent = styles;
            document.head.appendChild(styleElement);
        }

        setupEventListeners() {
            this.setupDragSystem();
            
            // No position saving on resize
            
            // Clean up on page unload
            window.addEventListener('beforeunload', () => this.cleanup());
            
            // Set up automatic character detection since extension_manager hooks don't work
            this.setupAutomaticCharacterDetection();
        }
        
        async loadSettingsHTML() {
            try {
                // Try to use renderExtensionTemplateAsync if available (ES6 module style)
                let settingsHtml = null;
                
                // Check if renderExtensionTemplateAsync is available globally or through extension system
                if (typeof renderExtensionTemplateAsync !== 'undefined') {
                    // Try to determine extension path - common patterns
                    const possiblePaths = [
                        'Media-Cycler',
                        'third-party/Media-Cycler',
                        `default-user/extensions/Media-Cycler`
                    ];
                    
                    for (const path of possiblePaths) {
                        try {
                            settingsHtml = await renderExtensionTemplateAsync(path, 'settings');
                            if (settingsHtml) {
                                this.debugLog(`✅ Media Cycler: Loaded settings HTML via renderExtensionTemplateAsync (${path})`);
                                break;
                            }
                        } catch (e) {
                            // Try next path
                        }
                    }
                }
                
                // Fallback: fetch the settings.html file directly
                if (!settingsHtml) {
                    try {
                        // Try to find the extension's base path
                        const scriptTag = document.querySelector('script[src*="Media-Cycler"]');
                        let basePath = '';
                        if (scriptTag && scriptTag.src) {
                            const match = scriptTag.src.match(/(.*\/)script\.js/);
                            if (match) {
                                basePath = match[1];
                            }
                        }
                        
                        // If we can't determine path from script tag, try common locations
                        if (!basePath) {
                            // Try relative to current location
                            const possiblePaths = [
                                '/default-user/extensions/Media-Cycler/settings.html',
                                '/extensions/Media-Cycler/settings.html',
                                './settings.html'
                            ];
                            
                            for (const path of possiblePaths) {
                                try {
                                    const response = await fetch(path);
                                    if (response.ok) {
                                        settingsHtml = await response.text();
                                        this.debugLog(`✅ Media Cycler: Loaded settings HTML via fetch (${path})`);
                                        break;
                                    }
                                } catch (e) {
                                    // Try next path
                                }
                            }
                        } else {
                            const response = await fetch(basePath + 'settings.html');
                            if (response.ok) {
                                settingsHtml = await response.text();
                                this.debugLog(`✅ Media Cycler: Loaded settings HTML via fetch (${basePath}settings.html)`);
                            }
                        }
                    } catch (e) {
                        this.debugWarn('⚠️ Media Cycler: Could not fetch settings.html:', e);
                    }
                }
                
                // Append to settings container if we got the HTML
                if (settingsHtml) {
                    const container = document.getElementById('extensions_settings') || document.getElementById('mediaCycler_container');
                    if (container) {
                        // Create a temporary div to parse the HTML
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = settingsHtml;
                        
                        // Append the parsed content
                        while (tempDiv.firstChild) {
                            container.appendChild(tempDiv.firstChild);
                        }
                        
                        this.debugLog('✅ Media Cycler: Settings HTML appended to container');
                    } else {
                        this.debugWarn('⚠️ Media Cycler: Could not find extensions_settings container');
                    }
                } else {
                    this.debugWarn('⚠️ Media Cycler: Could not load settings HTML');
                }
            } catch (error) {
                this.debugError('❌ Media Cycler: Error loading settings HTML:', error);
            }
        }
        
        initializeSettingsUI() {
            // Initialize settings button - settings.html might load asynchronously
            const initSettingsButton = () => {
                const resetButton = document.getElementById('mediaCycler-reset-default');
                if (resetButton) {
                    // Remove any existing listeners to avoid duplicates
                    const newButton = resetButton.cloneNode(true);
                    resetButton.parentNode.replaceChild(newButton, resetButton);
                    
                    // Add click handler
                    newButton.addEventListener('click', async () => {
                        if (this.resetToDefaultSettings) {
                            try {
                                await this.resetToDefaultSettings();
                            } catch (error) {
                                this.debugError('Error resetting settings:', error);
                            }
                        }
                    });
                    
                    this.debugLog('✅ Media Cycler: Settings button initialized');
                    return true;
                }
                return false;
            };
            
            // Try immediately
            if (initSettingsButton()) {
                return;
            }
            
            // If not found, poll for it (settings.html might load later)
            let attempts = 0;
            const maxAttempts = 50; // 5 seconds
            const checkInterval = setInterval(() => {
                attempts++;
                if (initSettingsButton() || attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                    if (attempts >= maxAttempts) {
                        this.debugWarn('⚠️ Media Cycler: Settings button not found after timeout');
                    }
                }
            }, 100);
        }
        
        setupAutomaticCharacterDetection() {
            // Periodic check every 3 seconds (silent, no console spam)
            this.intervals.push(setInterval(() => {
                this.detectCurrentCharacter(true).catch(() => {}); // Silent mode, ignore errors
            }, 3000));
            
            // Watch for DOM changes (debounced to avoid excessive checks)
            const observer = new MutationObserver(() => {
                if (!this.characterDetectionTimeout) {
                    this.characterDetectionTimeout = setTimeout(() => {
                        this.detectCurrentCharacter(true).catch(() => {}); // Silent mode, ignore errors
                        this.characterDetectionTimeout = null;
                    }, 1000); // 1 second debounce
                }
            });
            
            // Watch for text/content changes only
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: false
            });
            
            // Track observer for cleanup
            this.observers.push(observer);
        }

        setupThemeSync() {
            // Get theme colors from ST's computed styles
            this.updateThemeColors();
            
            // Lightweight observer: only watches for style attribute changes on root, not expensive
            const observer = new MutationObserver(() => {
                this.updateThemeColors();
            });
            
            // Watch for changes to document root styles (where ST sets theme vars)
            observer.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['style', 'class'],
                subtree: false
            });
            
            // Track observer for cleanup
            this.observers.push(observer);
            
            // Also check periodically (every 2 seconds) as fallback - very lightweight
            this.intervals.push(setInterval(() => this.updateThemeColors(), 2000));
        }

        updateThemeColors() {
            try {
                // Get a reference ST button to read computed styles
                const stButton = document.querySelector('.menu-button');
                if (!stButton) return;
                
                const computed = window.getComputedStyle(stButton);
                const root = getComputedStyle(document.documentElement);
                
                // Read actual UI background color from SillyTavern elements
                // Try body, main container, or any UI panel element
                const stBgElement = document.querySelector('body, #app, .main-content, .chat-container, .menu-button, .settings-menu');
                let actualBgColor = computed.backgroundColor || root.getPropertyValue('--SmartThemeBodyColor') || 'rgba(0,0,0,0.95)';
                if (stBgElement) {
                    const stBgComputed = getComputedStyle(stBgElement);
                    const stBg = stBgComputed.backgroundColor;
                    // Use the actual computed background color from SillyTavern elements
                    if (stBg && stBg !== 'rgba(0, 0, 0, 0)' && stBg !== 'transparent') {
                        actualBgColor = stBg;
                    }
                }
                
                // Text color - read from actual computed style of a button
                const textColor = computed.color || '#ffffff';
                const borderColor = computed.borderColor || root.getPropertyValue('--SmartThemeBorderColor') || 'rgba(255,255,255,0.2)';
                
                // Update CSS variables on document root
                const style = document.documentElement.style;
                style.setProperty('--media-cycler-bg', actualBgColor);
                style.setProperty('--media-cycler-text', textColor);
                style.setProperty('--media-cycler-border', borderColor);
                
                // Read actual text color from SillyTavern elements (not CSS variables which don't exist)
                // This is what the volume slider uses via accent-color, but we can't read that back
                const stTextElement = document.querySelector('body, .chat, .message, .menu-button, button');
                let actualTextColor = textColor;
                if (stTextElement) {
                    const stComputed = getComputedStyle(stTextElement);
                    const stColor = stComputed.color;
                    // Use the actual computed color from SillyTavern elements
                    if (stColor) {
                        actualTextColor = stColor;
                    }
                }
                
                // Apply to all Media Cycler buttons and icons - use setProperty with !important to override CSS
                const allButtons = document.querySelectorAll('.media-cycler-btn, .media-cycler-volume-icon, .media-cycler-tab-btn, .media-cycler-external-button');
                allButtons.forEach(btn => {
                    btn.style.setProperty('color', actualTextColor, 'important');
                });
                
                // Apply background color to lock and eye buttons
                const externalButtons = document.querySelectorAll('.media-cycler-external-button');
                externalButtons.forEach(btn => {
                    btn.style.setProperty('background-color', actualBgColor, 'important');
                });
                
                // Apply background color directly to containers (same approach as text color)
                if (this.elements.circleContainer) {
                    this.elements.circleContainer.style.setProperty('background-color', actualBgColor, 'important');
                    this.elements.circleContainer.style.setProperty('--text-color', actualTextColor);
                    this.elements.circleContainer.style.setProperty('--media-cycler-bg', actualBgColor);
                }
                if (this.elements.container) {
                    // Container should always be transparent so media shows through without background
                    this.elements.container.style.setProperty('background-color', 'transparent', 'important');
                    this.elements.container.style.setProperty('--text-color', actualTextColor);
                }
                if (this.elements.minimalUI) {
                    this.elements.minimalUI.style.setProperty('background-color', actualBgColor, 'important');
                    this.elements.minimalUI.style.setProperty('--text-color', actualTextColor);
                    this.elements.minimalUI.style.borderColor = borderColor;
                }
                
                // Keep top-half transparent - it should blend with circle background, not show as separate rectangle
                if (this.elements.topHalf) {
                    this.elements.topHalf.style.setProperty('background-color', 'transparent', 'important');
                }
                
                // Debug: Log what we're setting (only if debug enabled)
                if (this.state.debugEnabled) {
                    // Debug logging removed - was spamming console every 2 seconds
                    // Uncomment below if needed for debugging theme issues:
                    // this.debugLog('🎨 Theme sync - Setting colors:', {
                    //     'actualBgColor': actualBgColor,
                    //     'actualTextColor': actualTextColor,
                    //     'borderColor': borderColor
                    // });
                }
            } catch (e) {
                // Silently fail if theme detection doesn't work
            }
        }

        setupDragSystem() {
            // Make circle container draggable directly (it IS the controls now)
            if (this.elements.circleContainer) {
                this.makeElementDraggable(this.elements.circleContainer, false);
            }
        }

    makeElementDraggable(element, alwaysMovable = false) {
            let isDragging = false;
            let startX, startY, startLeft, startTop;

            const startDrag = (e) => {
                // Don't drag during background mode
                if (this.state.isBackgroundMode) return;
                
                // Don't drag if not in movable mode or if clicking a button or input
                if ((!alwaysMovable && !this.state.isMovableMode) || 
                    e.target.tagName === 'BUTTON' || 
                    e.target.tagName === 'INPUT' ||
                    e.target.closest('button') ||
                    e.target.closest('input')) return;
                
                // Get element bounds once
                const rect = element.getBoundingClientRect();
                
                // Check if clicking in the resize handle area (bottom-right corner, 20x20px)
                // Only for container (which is resizable), not circle container
                if (element.classList.contains('media-cycler-container')) {
                    const clickX = e.clientX - rect.left;
                    const clickY = e.clientY - rect.top;
                    const resizeHandleSize = 20;
                    const isInResizeHandle = 
                        clickX >= rect.width - resizeHandleSize && 
                        clickY >= rect.height - resizeHandleSize;
                    
                    if (isInResizeHandle) {
                        // Let the native resize handle work - don't start dragging
                        return;
                    }
                }
                
                e.preventDefault();
                isDragging = true;
                
                startX = e.clientX;
                startY = e.clientY;
                // For fixed positioned elements, use getBoundingClientRect instead of offsetLeft/Top
                startLeft = parseInt(element.style.left) || (isNaN(parseInt(element.style.left)) ? rect.left : parseInt(element.style.left));
                startTop = parseInt(element.style.top) || (isNaN(parseInt(element.style.top)) ? rect.top : parseInt(element.style.top));
                
                element.classList.add('movable-dragging');
                
                document.addEventListener('mousemove', drag);
                document.addEventListener('mouseup', stopDrag);
            };

            let rafId = null;
            const drag = (e) => {
                if (!isDragging) return;
                
                // Cancel any pending animation frame
                if (rafId) {
                    cancelAnimationFrame(rafId);
                }
                
                // Use requestAnimationFrame for smooth dragging
                rafId = requestAnimationFrame(() => {
                const deltaX = e.clientX - startX;
                const deltaY = e.clientY - startY;
                
                // Allow free movement - only constrain to keep element visible
                const newLeft = startLeft + deltaX;
                const newTop = startTop + deltaY;
                
                // Constrain to viewport but allow negative values for partial visibility
                const minLeft = -element.offsetWidth + 50; // Allow 50px to remain visible
                const maxLeft = window.innerWidth - 50;
                const minTop = -element.offsetHeight + 50;
                const maxTop = window.innerHeight - 50;
                
                element.style.left = Math.max(minLeft, Math.min(newLeft, maxLeft)) + 'px';
                element.style.top = Math.max(minTop, Math.min(newTop, maxTop)) + 'px';
                    rafId = null;
                });
            };

            const stopDrag = () => {
                if (!isDragging) return;
                isDragging = false;
                if (rafId) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }
                element.classList.remove('movable-dragging');
                document.removeEventListener('mousemove', drag);
                document.removeEventListener('mouseup', stopDrag);
                
                // Save positions after dragging ends
                this.saveAllSettings();
            };

            element.addEventListener('mousedown', startDrag);
        }

        async loadSavedData() {
            await this.loadSavedFileList();
            // Always start paused on load (handled in loadAllSettings, but ensure it's set)
            this.state.isEnabled = false;
        }

        async loadSavedFileList() {
            try {
                const metadata = await this.loadFileMetadata(null);
                this.debugLog(`🔍 ${EXTENSION_NAME}: Loading home list - found ${metadata.length} metadata entries, db exists: ${!!this.db}`);
                
                if (metadata.length > 0 && this.db) {
                    const blobFiles = await this.loadFileBlobs('');
                    if (blobFiles.length > 0) {
                        this.state.mediaFiles = blobFiles;
                        blobFiles.forEach(file => {
                            const objectURL = URL.createObjectURL(file);
                            this.state.objectURLs.set(file, objectURL);
                        });
                        this.state.validationStatus = { loaded: blobFiles.length, removed: 0 };
                        this.debugLog(`📁 ${EXTENSION_NAME}: Loaded ${blobFiles.length} files from IndexedDB blob storage`);
                        return;
                    }
                    this.debugWarn(`⚠️ ${EXTENSION_NAME}: Metadata exists but no files could be loaded (${metadata.length} metadata, ${blobFiles.length} blobs)`);
                } else if (metadata.length === 0) {
                    this.debugLog(`🔍 ${EXTENSION_NAME}: No metadata found for home list`);
                    
                    // Try loading from blob store even without metadata (in case metadata was lost)
                    if (this.db) {
                        const blobFiles = await this.loadFileBlobs('');
                        if (blobFiles.length > 0) {
                            this.state.mediaFiles = blobFiles;
                            blobFiles.forEach(file => {
                                const objectURL = URL.createObjectURL(file);
                                this.state.objectURLs.set(file, objectURL);
                            });
                            this.state.validationStatus = { loaded: blobFiles.length, removed: 0 };
                            this.debugLog(`📁 ${EXTENSION_NAME}: Loaded ${blobFiles.length} files from IndexedDB blob storage (no metadata)`);
                            return;
                        }
                    }
                }
                
                this.state.mediaFiles = [];
            } catch (error) {
                this.debugError(`❌ ${EXTENSION_NAME}: Failed to load saved files:`, error);
                this.state.mediaFiles = [];
            }
        }

        setDefaultPositions() {
            // Calculate viewport dimensions
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            
            // Controls (circle container): leftmost cut (0-20% of screen), centered vertically
            // Controls are 280px fixed size, so center them within the leftmost 20% cut
            if (this.elements.circleContainer) {
                const leftCutCenter = viewportWidth * 0.1; // Center of leftmost 20% cut (10% of screen)
                const controlsWidth = 280; // Fixed size from CSS
                const controlsLeft = leftCutCenter - (controlsWidth / 2); // Center the 280px circle
                const controlsTop = (viewportHeight / 2) - (controlsWidth / 2); // Center vertically
                
                this.elements.circleContainer.style.left = `${controlsLeft}px`;
                this.elements.circleContainer.style.top = `${controlsTop}px`;
                this.elements.circleContainer.style.right = 'auto';
                this.elements.circleContainer.style.bottom = 'auto';
                // Width and height are set via CSS (280px), no need to set here
            }
            
            // Media container: rightmost cut (80-100% of screen), centered vertically
            // Width: full width of rightmost cut (20% of viewport)
            // Height: half of viewport height (50vh)
            if (this.elements.container) {
                const rightCutLeft = viewportWidth * 0.8; // Start of rightmost 20% cut
                const containerWidth = viewportWidth * 0.2; // 20% of viewport width
                const containerHeight = viewportHeight * 0.5; // 50% of viewport height
                const containerTop = (viewportHeight / 2) - (containerHeight / 2); // Center vertically
                
                this.elements.container.style.left = `${rightCutLeft}px`;
                this.elements.container.style.top = `${containerTop}px`;
                this.elements.container.style.right = 'auto';
                this.elements.container.style.bottom = 'auto';
                this.elements.container.style.width = `${containerWidth}px`;
                this.elements.container.style.height = `${containerHeight}px`;
            }
            
            // Minimal UI: bottom left corner
            if (this.elements.minimalUI) {
                this.elements.minimalUI.style.bottom = '20px';
                this.elements.minimalUI.style.left = '20px';
                this.elements.minimalUI.style.top = 'auto';
                this.elements.minimalUI.style.right = 'auto';
            }
        }


        getDefaultSettings() {
            // Returns default settings object - these are the factory defaults
            return {
                imageDuration: 10,           // 10 seconds
                videoMinDuration: 8,         // 8 seconds min (loop short clips)
                videoMaxDuration: 15,        // 15 seconds max (cap long clips)
                playVideoUntilEnd: false,    // Don't play video until end
                volume: 0.8,                 // Volume level (but muted by default)
                isCharacterSpecificMode: false,  // Character-specific mode OFF
                fallbackToHome: false,           // Fallback OFF
                isShuffleMode: false,        // Shuffle OFF
                isEnabled: false,            // Paused
                isMovableMode: false,        // Movable mode OFF
                isAudioEnabled: false,       // Muted
                debugEnabled: false,         // Debug OFF
                isBackgroundMode: false      // Background mode OFF
            };
        }

        loadAllSettings() {
            try {
                // Always reset session-only state (NOT saved)
                this.state.isUIVisible = false;
                this.state.isMediaVisible = false;
                this.state.isAudioEnabled = false;
                this.state.isMovableMode = false;
                this.state.isEnabled = false;
                
                // Check if we should use defaults (flag set by "Default Settings" button)
                const useDefaults = localStorage.getItem(CONFIG.STORAGE_KEYS.USE_DEFAULTS_FLAG) === 'true';
                
                if (useDefaults) {
                    // Clear the flag so it only applies once
                    localStorage.removeItem(CONFIG.STORAGE_KEYS.USE_DEFAULTS_FLAG);
                    
                    // Load defaults (UI elements should exist at this point since this is after initialization)
                    const defaults = this.getDefaultSettings();
                    this.applyDefaultSettings(defaults, true); // Update UI since elements exist
                    // Save defaults so they persist
                    this.saveAllSettings();
                    return;
                }
                
                // Try to load from unified settings
                const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.SETTINGS);
                if (saved) {
                    const settings = JSON.parse(saved);
                    
                    // Load timing settings
                    if (settings.imageDuration !== undefined) {
                        this.state.imageDuration = Math.max(2, settings.imageDuration) * 1000;
                    }
                    if (settings.videoMinDuration !== undefined) {
                        this.state.videoMinDuration = Math.max(2000, settings.videoMinDuration * 1000);
                    } else {
                        this.state.videoMinDuration = 8000;
                    }
                    if (settings.videoMaxDuration !== undefined) {
                        this.state.videoMaxDuration = Math.max(2000, settings.videoMaxDuration * 1000);
                    } else {
                        this.state.videoMaxDuration = 15000;
                    }
                    if (this.state.videoMinDuration > this.state.videoMaxDuration) {
                        this.state.videoMaxDuration = this.state.videoMinDuration;
                    }
                    if (settings.playVideoUntilEnd !== undefined) {
                        this.state.playVideoUntilEnd = settings.playVideoUntilEnd;
                    }
                    
                    // Load audio settings
                    if (settings.volume !== undefined) {
                        this.state.volume = Math.max(0, Math.min(1, settings.volume));
                    }
                    
                    // Load character mode settings
                    if (settings.isCharacterSpecificMode !== undefined) {
                        this.state.isCharacterSpecificMode = settings.isCharacterSpecificMode;
                    }
                    if (settings.fallbackToHome !== undefined) {
                        this.state.fallbackToHome = settings.fallbackToHome;
                    }
                    
                    // Load shuffle (merged into main settings)
                    if (settings.isShuffleMode !== undefined) {
                        this.state.isShuffleMode = settings.isShuffleMode;
                    }
                    
                    // Load debug
                    if (settings.debugEnabled !== undefined) {
                        this.state.debugEnabled = settings.debugEnabled;
                    }
                    
                    // Note: UI positions are loaded separately via loadUIPositions() after UI elements are created
                } else {
                    // No saved settings - use defaults on first load (UI elements don't exist yet)
                    const defaults = this.getDefaultSettings();
                    this.applyDefaultSettings(defaults, false); // Don't update UI yet
                    // Save defaults so they persist
                    this.saveAllSettings();
                }
            } catch (e) {
                this.debugWarn('⚠️ Failed to load settings:', e);
                // On error, use defaults (UI elements don't exist yet)
                const defaults = this.getDefaultSettings();
                this.applyDefaultSettings(defaults, false); // Don't update UI yet
            }
        }

        loadUIPositions() {
            // Load only UI positions from saved settings (called after UI elements are created)
            try {
                const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.SETTINGS);
                if (saved) {
                    const settings = JSON.parse(saved);
                    
                    // Load UI positions FIRST (before applying background mode)
                    if (settings.positions && this.elements.container) {
                        const pos = settings.positions.container;
                        if (pos) {
                            if (pos.left) this.elements.container.style.left = pos.left;
                            if (pos.top) this.elements.container.style.top = pos.top;
                            if (pos.width) this.elements.container.style.width = pos.width;
                            if (pos.height) this.elements.container.style.height = pos.height;
                            if (pos.left || pos.top) {
                                this.elements.container.style.right = 'auto';
                                this.elements.container.style.bottom = 'auto';
                            }
                        }
                    }
                    
                    // Load background mode state AFTER loading positions
                    if (settings.isBackgroundMode === true && this.elements.container) {
                        // Apply background mode if it was saved as on
                        this.state.isBackgroundMode = true;
                        this.applyBackgroundModeState();
                    }
                    
                    if (settings.positions && this.elements.circleContainer) {
                        const pos = settings.positions.circleContainer;
                        if (pos) {
                            if (pos.left) this.elements.circleContainer.style.left = pos.left;
                            if (pos.top) this.elements.circleContainer.style.top = pos.top;
                            if (pos.left || pos.top) {
                                this.elements.circleContainer.style.right = 'auto';
                                this.elements.circleContainer.style.bottom = 'auto';
                            }
                        }
                    }
                    
                    if (settings.positions && this.elements.minimalUI) {
                        const pos = settings.positions.minimalUI;
                        if (pos) {
                            // Only set position if it's not empty and is a valid positive value
                            if (pos.bottom && pos.bottom.trim() !== '' && pos.bottom !== 'auto') {
                                // Validate bottom value - must be positive or reasonable
                                const bottomValue = parseFloat(pos.bottom);
                                if (!isNaN(bottomValue) && bottomValue >= -50 && bottomValue <= window.innerHeight + 100) {
                                    this.elements.minimalUI.style.bottom = pos.bottom;
                                } else {
                                    // Invalid bottom value - use default
                                    this.elements.minimalUI.style.bottom = '20px';
                                }
                            }
                            if (pos.left && pos.left.trim() !== '' && pos.left !== 'auto') {
                                // Validate left value
                                const leftValue = parseFloat(pos.left);
                                if (!isNaN(leftValue) && leftValue >= -50 && leftValue <= window.innerWidth + 100) {
                                    this.elements.minimalUI.style.left = pos.left;
                                } else {
                                    // Invalid left value - use default
                                    this.elements.minimalUI.style.left = '20px';
                                }
                            }
                            // Ensure top/right are auto when using bottom/left
                            if ((pos.bottom && pos.bottom.trim() !== '' && pos.bottom !== 'auto') || 
                                (pos.left && pos.left.trim() !== '' && pos.left !== 'auto')) {
                                this.elements.minimalUI.style.top = 'auto';
                                this.elements.minimalUI.style.right = 'auto';
                            }
                        }
                    }
                    // Ensure minimal UI visibility is correct after loading positions
                    // Also validate that bottom position is not negative (off-screen)
                    if (this.elements.minimalUI) {
                        const computed = window.getComputedStyle(this.elements.minimalUI);
                        const bottomValue = parseFloat(computed.bottom);
                        // If bottom is negative or way off-screen, reset to default
                        if (!isNaN(bottomValue) && (bottomValue < -50 || bottomValue > window.innerHeight + 100)) {
                            this.elements.minimalUI.style.bottom = '20px';
                            this.elements.minimalUI.style.left = '20px';
                            this.elements.minimalUI.style.top = 'auto';
                            this.elements.minimalUI.style.right = 'auto';
                            // Save the corrected position
                            this.saveAllSettings();
                        }
                        this.updateEyeButtons();
                    }
                }
            } catch (e) {
                this.debugWarn('⚠️ Failed to load UI positions:', e);
            }
        }

        applyDefaultSettings(defaults, updateUI = false) {
            // Apply default settings to state (convert durations from seconds to milliseconds)
            this.state.imageDuration = defaults.imageDuration * 1000;
            this.state.videoMinDuration = (defaults.videoMinDuration !== undefined ? defaults.videoMinDuration : 8) * 1000;
            this.state.videoMaxDuration = (defaults.videoMaxDuration !== undefined ? defaults.videoMaxDuration : 15) * 1000;
            if (this.state.videoMinDuration > this.state.videoMaxDuration) {
                this.state.videoMaxDuration = this.state.videoMinDuration;
            }
            this.state.playVideoUntilEnd = defaults.playVideoUntilEnd;
            this.state.volume = defaults.volume;
            this.state.isCharacterSpecificMode = defaults.isCharacterSpecificMode;
            this.state.fallbackToHome = defaults.fallbackToHome;
            this.state.isShuffleMode = defaults.isShuffleMode;
            this.state.isEnabled = defaults.isEnabled;
            this.state.isMovableMode = defaults.isMovableMode;
            this.state.isAudioEnabled = defaults.isAudioEnabled;
            this.state.debugEnabled = defaults.debugEnabled;
            this.state.isBackgroundMode = defaults.isBackgroundMode !== undefined ? defaults.isBackgroundMode : false;
            
            // Clear shuffle state from localStorage
            localStorage.removeItem(CONFIG.STORAGE_KEYS.SHUFFLE);
            
            // Only update UI if requested and elements exist
            if (updateUI) {
                // Reset UI positions to defaults
                if (this.elements.container || this.elements.circleContainer) {
                    this.setDefaultPositions();
                }
                
                // Update UI elements to reflect defaults
                if (typeof this.updateMovableUI === 'function') {
                    this.updateMovableUI();
                }
                if (typeof this.updateShuffleUI === 'function') {
                    this.updateShuffleUI();
                }
                if (typeof this.updateCharacterModeUI === 'function') {
                    this.updateCharacterModeUI();
                }
                if (this.elements.toggleBtn && typeof this.updatePlayPauseIcon === 'function') {
                    this.updatePlayPauseIcon();
                }
                // Apply background mode state if needed
                if (typeof this.applyBackgroundModeState === 'function') {
                    this.applyBackgroundModeState();
                }
            }
        }

        async resetToDefaultSettings() {
            // Show confirmation dialog
            const confirmed = await this.showDefaultSettingsDialog();
            if (!confirmed) {
                return;
            }
            
            // Set flag to use defaults on next load
            localStorage.setItem(CONFIG.STORAGE_KEYS.USE_DEFAULTS_FLAG, 'true');
            
            // Show notification that refresh is needed
            this.showTooltipNotification('Settings will reset to defaults after page refresh. Please refresh the page now.');
        }

        async showDefaultSettingsDialog() {
            return new Promise((resolve) => {
                // Create dialog overlay
                const overlay = this.createElement('div', {
                    style: 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 100000; display: flex; align-items: center; justify-content: center;'
                });

                // Create dialog box
                const dialog = this.createElement('div', {
                    style: 'background: var(--bg-primary, rgba(30,30,30,0.95)); border: 1px solid var(--border-color, rgba(255,255,255,0.2)); border-radius: 8px; padding: 20px; max-width: 500px; width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.5);'
                });

                // Title
                const title = this.createElement('div', {
                    style: 'font-size: 16px; font-weight: 600; margin-bottom: 12px; color: var(--text-color, rgba(255,255,255,0.9));'
                });
                title.textContent = 'Reset to Default Settings';

                // Description
                const desc = this.createElement('div', {
                    style: 'font-size: 13px; color: var(--text-color, rgba(255,255,255,0.7)); margin-bottom: 16px; line-height: 1.4;'
                });
                desc.innerHTML = 'This will reset all settings to their default values:<br><br>' +
                    '• Image duration: 10 seconds<br>' +
                    '• Video duration: 10 seconds<br>' +
                    '• Play video until end: OFF<br>' +
                    '• Volume: Muted<br>' +
                    '• Character-specific mode: OFF<br>' +
                    '• Fallback to home: OFF<br>' +
                    '• Shuffle: OFF<br>' +
                    '• Movable mode: OFF<br>' +
                    '• Background mode: OFF<br>' +
                    '• Playback: Paused<br><br>' +
                    '<strong>Note:</strong> This will NOT affect your media lists. Settings will take effect after you refresh the page.';

                // Button container
                const buttonContainer = this.createElement('div', {
                    style: 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px;'
                });

                // Cancel button
                const cancelBtn = this.createElement('button', {
                    style: 'padding: 8px 16px; background: var(--button-bg, rgba(255,255,255,0.1)); color: var(--text-color, white); border: 1px solid var(--border-color, rgba(255,255,255,0.2)); border-radius: 4px; cursor: pointer; font-size: 13px;'
                });
                cancelBtn.textContent = 'Cancel';
                cancelBtn.onclick = () => {
                    overlay.remove();
                    resolve(false);
                };

                // Confirm button
                const confirmBtn = this.createElement('button', {
                    style: 'padding: 8px 16px; background: var(--danger-bg, rgba(220,53,69,0.8)); color: var(--danger-fg, white); border: 1px solid var(--danger-border, rgba(220,53,69,0.5)); border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500;'
                });
                confirmBtn.textContent = 'Reset to Defaults';
                confirmBtn.onclick = () => {
                    overlay.remove();
                    resolve(true);
                };

                buttonContainer.append(cancelBtn, confirmBtn);
                dialog.append(title, desc, buttonContainer);
                overlay.appendChild(dialog);
                document.body.appendChild(overlay);

                // Close on overlay click
                overlay.onclick = (e) => {
                    if (e.target === overlay) {
                        overlay.remove();
                        resolve(false);
                    }
                };
            });
        }

        saveAllSettings() {
            try {
                // Ensure values are within valid ranges before saving
                // Save durations in seconds (not milliseconds) for easier editing
                const settings = {
                    // Timing settings
                    imageDuration: Math.max(2, this.state.imageDuration / 1000),
                    videoMinDuration: Math.max(2, this.state.videoMinDuration / 1000),
                    videoMaxDuration: Math.max(2, this.state.videoMaxDuration / 1000),
                    playVideoUntilEnd: this.state.playVideoUntilEnd,
                    
                    // Audio settings
                    volume: Math.max(0, Math.min(1, this.state.volume)),
                    
                    // Character mode settings
                    isCharacterSpecificMode: this.state.isCharacterSpecificMode,
                    fallbackToHome: this.state.fallbackToHome,
                    
                    // Playback settings
                    isShuffleMode: this.state.isShuffleMode,
                    
                    // Background mode
                    isBackgroundMode: this.state.isBackgroundMode,
                    
                    // Debug
                    debugEnabled: this.state.debugEnabled,
                    
                    // UI Positions
                    positions: {
                        container: this.elements.container ? (
                            // If background mode is ON, save the previous state (original position) instead of current fullscreen
                            this.state.isBackgroundMode && this.state.previousContainerState ? {
                                left: this.state.previousContainerState.left || '',
                                top: this.state.previousContainerState.top || '',
                                width: this.state.previousContainerState.width || '',
                                height: this.state.previousContainerState.height || ''
                            } : {
                                left: this.elements.container.style.left || '',
                                top: this.elements.container.style.top || '',
                                width: this.elements.container.style.width || '',
                                height: this.elements.container.style.height || ''
                            }
                        ) : null,
                        circleContainer: this.elements.circleContainer ? {
                            left: this.elements.circleContainer.style.left || '',
                            top: this.elements.circleContainer.style.top || ''
                        } : null,
                        minimalUI: this.elements.minimalUI ? {
                            bottom: this.elements.minimalUI.style.bottom || '',
                            left: this.elements.minimalUI.style.left || ''
                        } : null
                    }
                };
                localStorage.setItem(CONFIG.STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
            } catch (e) {
                this.debugWarn('⚠️ Failed to save settings:', e);
            }
        }

        // Alias for convenience
        saveSettings() {
            this.saveAllSettings();
        }


        async showDuplicateDialog(duplicateCount, duplicateNames) {
            return new Promise((resolve) => {
                // Create dialog overlay
                const overlay = this.createElement('div', {
                    style: 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 100000; display: flex; align-items: center; justify-content: center;'
                });

                // Create dialog box
                const dialog = this.createElement('div', {
                    style: 'background: var(--bg-primary, rgba(30,30,30,0.95)); border: 1px solid var(--border-color, rgba(255,255,255,0.2)); border-radius: 8px; padding: 20px; max-width: 500px; width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.5);'
                });

                // Title
                const title = this.createElement('div', {
                    style: 'font-size: 16px; font-weight: 600; margin-bottom: 12px; color: var(--text-color, rgba(255,255,255,0.9));'
                });
                title.textContent = `${duplicateCount} duplicate file${duplicateCount === 1 ? '' : 's'} found`;

                // Description
                const desc = this.createElement('div', {
                    style: 'font-size: 13px; color: var(--text-color, rgba(255,255,255,0.7)); margin-bottom: 16px; line-height: 1.4;'
                });
                desc.innerHTML = 'What would you like to do?<br><br>• <strong>Keep Only New</strong>: Add only new files. Duplicates will be ignored.<br>• <strong>Removal & Keep New</strong>: Remove the matching files from your list, then add the new files (If any). Use this to remove specific files by selecting them in the picker.<br><br>';

                // Button container
                const buttonContainer = this.createElement('div', {
                    style: 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px;'
                });

                // Cancel button
                const cancelBtn = this.createSTButton('Cancel', 'media-cycler-dialog-cancel', () => {
                    document.body.removeChild(overlay);
                    resolve('cancel');
                });
                cancelBtn.style.marginRight = 'auto';

                // Keep existing button
                const keepBtn = this.createSTButton('Only New', 'media-cycler-dialog-keep', () => {
                    document.body.removeChild(overlay);
                    resolve('keep');
                });

                // Remove duplicates button
                const removeBtn = this.createSTButton('Removal & Keep New', 'media-cycler-dialog-remove', () => {
                    document.body.removeChild(overlay);
                    resolve('remove');
                });
                removeBtn.style.background = 'var(--danger-bg, rgba(200,50,50,0.8))';

                buttonContainer.append(cancelBtn, keepBtn, removeBtn);
                dialog.append(title, desc, buttonContainer);
                overlay.appendChild(dialog);
                document.body.appendChild(overlay);

                // Close on overlay click (outside dialog)
                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) {
                        document.body.removeChild(overlay);
                        resolve('cancel');
                    }
                });
            });
        }

        async removeDuplicateFiles(listType, characterId, duplicateFileKeys) {
            if (listType === 'character' && characterId) {
                const charList = this.state.characterLists.get(characterId);
                if (!charList) return 0;

                let removedCount = 0;
                const originalLength = charList.files.length;
                
                // Check if currently playing file is being removed (before filtering)
                // Need to check against the character list files, not mediaFiles (which will be reloaded)
                let currentFileRemoved = false;
                if (this.state.activeListType === 'character' && this.state.currentCharacterId === characterId && 
                    this.state.currentIndex < this.state.mediaFiles.length) {
                    const currentFile = this.state.mediaFiles[this.state.currentIndex];
                    if (currentFile) {
                        const currentFileKey = currentFile.fileKey || `${currentFile.name}-${currentFile.size}-${currentFile.lastModified}`;
                        // Check if this file exists in the character list and is being removed
                        const fileInCharList = charList.files.find(f => {
                            const fKey = f.fileKey || `${f.name}-${f.size}-${f.lastModified}`;
                            return fKey === currentFileKey;
                        });
                        if (fileInCharList) {
                            currentFileRemoved = duplicateFileKeys.has(currentFileKey);
                        }
                    }
                }
                const wasPlaying = this.state.isEnabled && currentFileRemoved;

                // Remove files matching duplicate keys
                charList.files = charList.files.filter(file => {
                    const fileKey = file.fileKey || `${file.name}-${file.size}-${file.lastModified}`;
                    const shouldRemove = duplicateFileKeys.has(fileKey);
                    if (shouldRemove) {
                        // Clean up object URL
                        const url = this.state.objectURLs.get(file);
                        if (url) {
                            URL.revokeObjectURL(url);
                            this.state.objectURLs.delete(file);
                        }
                        removedCount++;
                    }
                    return !shouldRemove;
                });

                // Remove corresponding metadata
                charList.metadata = charList.metadata.filter(meta => {
                    const fileKey = meta.fileKey || `${meta.name}-${meta.size}-${meta.lastModified}`;
                    return !duplicateFileKeys.has(fileKey);
                });

                // Remove from IndexedDB
                if (this.db && removedCount > 0) {
                    try {
                        const prefix = `char_${characterId}_`;
                        const transaction = this.db.transaction([CONFIG.INDEXEDDB_STORE, CONFIG.INDEXEDDB_BLOB_STORE], 'readwrite');
                        
                        // Wait for transaction to complete
                        await new Promise((resolve, reject) => {
                            transaction.oncomplete = () => resolve();
                            transaction.onerror = () => reject(transaction.error);
                            
                            // Remove handles
                            const handleStore = transaction.objectStore(CONFIG.INDEXEDDB_STORE);
                            const handleIndex = handleStore.index('prefix');
                            const handleRequest = handleIndex.openCursor(IDBKeyRange.only(prefix));
                            handleRequest.onsuccess = (event) => {
                                const cursor = event.target.result;
                                if (cursor) {
                                    const meta = cursor.value.metadata;
                                    const fileKey = meta?.fileKey || `${meta?.name}-${meta?.size}-${meta?.lastModified}`;
                                    if (duplicateFileKeys.has(fileKey)) {
                                        cursor.delete();
                                    }
                                    cursor.continue();
                                }
                            };

                            // Remove blobs
                            const blobStore = transaction.objectStore(CONFIG.INDEXEDDB_BLOB_STORE);
                            const blobIndex = blobStore.index('prefix');
                            const blobRequest = blobIndex.openCursor(IDBKeyRange.only(prefix));
                            blobRequest.onsuccess = (event) => {
                                const cursor = event.target.result;
                                if (cursor) {
                                    const meta = cursor.value.metadata;
                                    const fileKey = meta?.fileKey || `${meta?.name}-${meta?.size}-${meta?.lastModified}`;
                                    if (duplicateFileKeys.has(fileKey)) {
                                        cursor.delete();
                                    }
                                    cursor.continue();
                                }
                            };
                        });
                    } catch (e) {
                        this.debugWarn(`⚠️ ${EXTENSION_NAME}: Failed to remove duplicates from IndexedDB:`, e);
                    }
                }

                this.saveCharacterLists();
                
                // Update storage capacity after removing duplicates
                await this.checkStorageCapacity();

                // If this is the active list, update state
                if (this.state.activeListType === 'character' && this.state.currentCharacterId === characterId) {
                    // Clear current media files first to ensure clean reload
                    this.state.mediaFiles = [];
                    this.cleanupObjectURLs();
                    // Small delay to ensure IndexedDB transaction is fully committed
                    await new Promise(resolve => setTimeout(resolve, 50));
                    // Now reload from the updated character list
                    await this.loadCharacterMediaList(characterId);
                    
                    // Handle case where currently playing file was removed
                    if (wasPlaying && this.state.mediaFiles.length > 0) {
                        // Currently playing file was removed - move to next
                        // After filtering, currentIndex might now point to a different file
                        // We want to show the next file, so we'll use showNextMedia which handles it
                        if (this.state.isShuffleMode) {
                            // Rebuild shuffle queue for remaining files
                            this.reshuffleIndices();
                            // Show first file in new shuffled queue
                            if (this.state.shuffledIndices && this.state.shuffledIndices.length > 0) {
                                this.state.currentIndex = this.state.shuffledIndices[0];
                                this.state.shuffleIndex = 1; // Next call will get next in queue
                                this.state.mediaStartTime = Date.now();
                                this.showMedia(this.state.currentIndex);
                                this.scheduleNextMedia();
                                this.updateStatusDisplay();
                            } else {
                                this.showNextMedia();
                            }
                        } else {
                            // Normal mode - after filtering, currentIndex now points to the next available file
                            // (because the array was filtered, indices shifted)
                            // Example: at file 2, delete 2,3,4 -> array becomes [0,1,5,6], index 2 now points to what was file 5
                            // So we should show what's at currentIndex (the next available file)
                            if (this.state.currentIndex >= this.state.mediaFiles.length) {
                                // If index is out of bounds, wrap to 0
                                this.state.currentIndex = 0;
                            }
                            // Show the file at currentIndex (which is now the next available file after deletions)
                            this.state.mediaStartTime = Date.now();
                            this.showMedia(this.state.currentIndex);
                            this.scheduleNextMedia();
                            this.updateStatusDisplay();
                        }
                    } else if (this.state.mediaFiles.length === 0) {
                        // No files left - clear media and stop
                        this.stopAndClearMedia();
                        this.state.isEnabled = false;
                        if (this.elements.toggleBtn) {
                            this.updatePlayPauseIcon();
                            this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn paused';
                        }
                        this.state.currentIndex = 0;
                        this.state.validationStatus = null;
                    } else {
                        // Files remain but current wasn't playing or wasn't removed - just ensure index is valid
                        if (this.state.currentIndex >= this.state.mediaFiles.length) {
                            this.state.currentIndex = 0;
                        }
                    }
                    
                    // Force update validation status to reflect new file count (after loadCharacterMediaList may have set it)
                    if (this.state.mediaFiles.length > 0) {
                        this.state.validationStatus = {
                            loaded: this.state.mediaFiles.length,
                            removed: 0
                        };
                    } else {
                        this.state.validationStatus = null;
                        this.state.currentIndex = 0;
                    }
                    // Force immediate UI updates - updateUIState calls updateFileCountDisplay and updateStatusDisplay
                    this.updateUIState();
                }

                this.updateCharacterListUI();
                return removedCount;
            } else {
                // Home list
                let removedCount = 0;
                const originalLength = this.state.mediaFiles.length;
                
                // Check if currently playing file is being removed (before filtering)
                let currentFileRemoved = false;
                if (this.state.activeListType === 'home' && this.state.currentIndex < this.state.mediaFiles.length) {
                    const currentFile = this.state.mediaFiles[this.state.currentIndex];
                    if (currentFile) {
                        const currentFileKey = currentFile.fileKey || `${currentFile.name}-${currentFile.size}-${currentFile.lastModified}`;
                        currentFileRemoved = duplicateFileKeys.has(currentFileKey);
                    }
                }
                const wasPlaying = this.state.isEnabled && currentFileRemoved;

                // Remove files matching duplicate keys
                this.state.mediaFiles = this.state.mediaFiles.filter(file => {
                    const fileKey = file.fileKey || `${file.name}-${file.size}-${file.lastModified}`;
                    const shouldRemove = duplicateFileKeys.has(fileKey);
                    if (shouldRemove) {
                        // Clean up object URL
                        const url = this.state.objectURLs.get(file);
                        if (url) {
                            URL.revokeObjectURL(url);
                            this.state.objectURLs.delete(file);
                        }
                        removedCount++;
                    }
                    return !shouldRemove;
                });

                // Remove from IndexedDB
                if (this.db && removedCount > 0) {
                    try {
                        const transaction = this.db.transaction([CONFIG.INDEXEDDB_STORE, CONFIG.INDEXEDDB_BLOB_STORE], 'readwrite');
                        
                        // Wait for transaction to complete
                        await new Promise((resolve, reject) => {
                            transaction.oncomplete = () => resolve();
                            transaction.onerror = () => reject(transaction.error);
                            
                            // Remove handles
                            const handleStore = transaction.objectStore(CONFIG.INDEXEDDB_STORE);
                            const handleIndex = handleStore.index('prefix');
                            const handleRequest = handleIndex.openCursor(IDBKeyRange.only(''));
                            handleRequest.onsuccess = (event) => {
                                const cursor = event.target.result;
                                if (cursor) {
                                    // Handle structure: { fileKey, handle, originalKey, prefix }
                                    const fileKey = cursor.value.originalKey || cursor.value.fileKey;
                                    if (fileKey && duplicateFileKeys.has(fileKey)) {
                                        cursor.delete();
                                    }
                                    cursor.continue();
                                }
                            };

                            // Remove blobs
                            const blobStore = transaction.objectStore(CONFIG.INDEXEDDB_BLOB_STORE);
                            const blobIndex = blobStore.index('prefix');
                            const blobRequest = blobIndex.openCursor(IDBKeyRange.only(''));
                            blobRequest.onsuccess = (event) => {
                                const cursor = event.target.result;
                                if (cursor) {
                                    // Blob structure: { fileKey, blob, originalKey, prefix }
                                    const fileKey = cursor.value.originalKey || cursor.value.fileKey;
                                    if (fileKey && duplicateFileKeys.has(fileKey)) {
                                        cursor.delete();
                                    }
                                    cursor.continue();
                                }
                            };
                        });
                    } catch (e) {
                        this.debugWarn(`⚠️ ${EXTENSION_NAME}: Failed to remove duplicates from IndexedDB:`, e);
                    }
                }

                // Sync metadata to match current mediaFiles state (after duplicates removed)
                await this.syncHomeListMetadata();
                if (listType === 'home') {
                    this.updateHomeListStatus();
                }

                // Update storage capacity after removing duplicates
                await this.checkStorageCapacity();

                // Update UI if home list is active
                if (this.state.activeListType === 'home' && 
                    (!this.state.isCharacterSpecificMode || this.state.fallbackToHome)) {
                    
                    // Handle case where currently playing file was removed
                    if (wasPlaying && this.state.mediaFiles.length > 0) {
                        // Currently playing file was removed - move to next
                        // After filtering, currentIndex might now point to a different file
                        // We want to show the next file, so we'll use showNextMedia which handles it
                        if (this.state.isShuffleMode) {
                            // Rebuild shuffle queue for remaining files
                            this.reshuffleIndices();
                            // Show first file in new shuffled queue
                            if (this.state.shuffledIndices && this.state.shuffledIndices.length > 0) {
                                this.state.currentIndex = this.state.shuffledIndices[0];
                                this.state.shuffleIndex = 1; // Next call will get next in queue
                                this.state.mediaStartTime = Date.now();
                                this.showMedia(this.state.currentIndex);
                                this.scheduleNextMedia();
                                this.updateStatusDisplay();
                            } else {
                                this.showNextMedia();
                            }
                        } else {
                            // Normal mode - after filtering, currentIndex now points to the next available file
                            // (because the array was filtered, indices shifted)
                            // Example: at file 2, delete 2,3,4 -> array becomes [0,1,5,6], index 2 now points to what was file 5
                            // So we should show what's at currentIndex (the next available file)
                            if (this.state.currentIndex >= this.state.mediaFiles.length) {
                                // If index is out of bounds, wrap to 0
                                this.state.currentIndex = 0;
                            }
                            // Show the file at currentIndex (which is now the next available file after deletions)
                            this.state.mediaStartTime = Date.now();
                            this.showMedia(this.state.currentIndex);
                            this.scheduleNextMedia();
                            this.updateStatusDisplay();
                        }
                    } else if (this.state.mediaFiles.length === 0) {
                        // No files left - clear media and stop
                        this.stopAndClearMedia();
                        this.state.isEnabled = false;
                        if (this.elements.toggleBtn) {
                            this.updatePlayPauseIcon();
                            this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn paused';
                        }
                        this.state.currentIndex = 0;
                        this.state.validationStatus = null;
                    } else {
                        // Files remain but current wasn't playing or wasn't removed - just ensure index is valid
                        if (this.state.currentIndex >= this.state.mediaFiles.length) {
                            this.state.currentIndex = 0;
                        }
                    }
                    
                    // Update validation status to reflect new file count
                    if (this.state.mediaFiles.length > 0) {
                        this.state.validationStatus = {
                            loaded: this.state.mediaFiles.length,
                            removed: 0
                        };
                    } else {
                        this.state.validationStatus = null;
                        this.state.currentIndex = 0;
                    }
                    // Force immediate UI updates - updateUIState calls updateFileCountDisplay and updateStatusDisplay
                    this.updateUIState();
                }
                
                // Update storage capacity after removing duplicates
                await this.checkStorageCapacity();

                return removedCount;
            }
        }

        async handleFileSystemSelection(listType = 'home', characterId = null) {
            this.state.pendingFileSelection = { listType, characterId };
            this.elements.fileInput.click();
        }

        async handleFileSelection(event) {
            const files = Array.from(event.target.files);
            if (files.length === 0) {
                this.showStatusMessage('No files selected');
                this.state.pendingFileSelection = null; // Clear pending selection
                return;
            }

            // Get the pending selection context (set by handleFileSystemSelection)
            const pending = this.state.pendingFileSelection || { listType: 'home', characterId: null };
            const listType = pending.listType;
            const characterId = pending.characterId;
            this.state.pendingFileSelection = null; // Clear after use

            this.debugLog(`📁 ${EXTENSION_NAME}: User selected ${files.length} files (fallback method, ${listType}${characterId ? `, character: ${characterId}` : ''})`);

            // Filter out transparent placeholder and validate file types
            const validFiles = [];
            const invalidFiles = [];
            
            files.forEach(file => {
                // Skip transparent placeholder
                if (file.name === '__transparent.png') {
                    return;
                }
                
                // Validate file type
                const validation = this.isValidMediaFile(file);
                if (validation.valid) {
                    validFiles.push(file);
                } else {
                    invalidFiles.push({ file, reason: validation.reason });
                }
            });
            
            // Show warning if invalid files were found
            if (invalidFiles.length > 0) {
                const invalidNames = invalidFiles.map(f => f.file.name).slice(0, 5).join(', ');
                const moreText = invalidFiles.length > 5 ? ` and ${invalidFiles.length - 5} more` : '';
                this.showStatusMessage(
                    `⚠️ ${invalidFiles.length} invalid file(s) skipped: ${invalidNames}${moreText}`
                );
                this.debugWarn(`⚠️ ${EXTENSION_NAME}: Skipped ${invalidFiles.length} invalid files:`, invalidFiles.map(f => f.file.name));
            }
            
            if (validFiles.length === 0) {
                this.showStatusMessage('No valid media files selected');
                this.state.pendingFileSelection = null;
                event.target.value = '';
                return;
            }
            
            // Check for duplicates - use appropriate list based on listType
            let existing;
            if (listType === 'character' && characterId) {
                const charList = this.state.characterLists.get(characterId);
                existing = new Set(
                    (charList?.files || []).map(f => {
                        if (f.fileKey) return f.fileKey;
                        return `${f.name}-${f.size}-${f.lastModified}`;
                    })
                );
            } else {
                existing = new Set(
                    this.state.mediaFiles.map(f => {
                        if (f.fileKey) return f.fileKey;
                        return `${f.name}-${f.size}-${f.lastModified}`;
                    })
                );
            }
            
            // Separate duplicates and new files
            const duplicateFiles = [];
            const duplicateFileKeys = new Set();
            const uniqueToAdd = validFiles.filter(file => {
                const key = `${file.name}-${file.size}-${file.lastModified}`;
                if (existing.has(key)) {
                    duplicateFiles.push({ file, fileKey: key });
                    duplicateFileKeys.add(key);
                    return false;
                }
                return true;
            });

            // If duplicates found, show dialog
            let action = 'keep';
            if (duplicateFiles.length > 0) {
                const duplicateNames = duplicateFiles.map(d => d.file.name);
                action = await this.showDuplicateDialog(duplicateFiles.length, duplicateNames);
                
                if (action === 'cancel') {
                    // User cancelled - clear file input
                    event.target.value = '';
                    return;
                } else if (action === 'remove') {
                    // Remove duplicates from list
                    const removedCount = await this.removeDuplicateFiles(listType, characterId, duplicateFileKeys);
                    
                    if (uniqueToAdd.length === 0) {
                        this.showStatusMessage(`Removed ${removedCount} duplicate file${removedCount === 1 ? '' : 's'}`);
                        // Update character list UI to reflect removed files
                        this.updateCharacterListUI();
                        event.target.value = '';
                        return;
                    }
                }
                // If action === 'keep', just continue with adding new files
            }

            if (uniqueToAdd.length === 0) {
                this.showStatusMessage('No new files to add');
                event.target.value = '';
                return;
            }

            // Create fileKeys and add fileKey property to files
            const filesWithKeys = uniqueToAdd.map(file => {
                const fileKey = `${file.name}-${file.size}-${file.lastModified}`;
                const fileObj = Object.assign(file, { fileKey });
                return fileObj;
            });

            // Handle character list addition
            if (listType === 'character' && characterId) {
                // Add to character list
                // Check storage capacity before saving (fallback browsers only)
                const canSave = await this.checkStorageBeforeAdd(filesWithKeys);
                if (!canSave) {
                    this.showStatusMessage('Cannot add files - storage would exceed limit');
                    event.target.value = '';
                    return;
                }
                
                // Save blobs to IndexedDB for fallback method (chunked to keep UI responsive)
                const prefix = `char_${characterId}_`;
                await this.saveFileBlobsChunked(filesWithKeys, prefix);
                
                // Update storage capacity after adding files
                await this.checkStorageCapacity();
                
                const filesToAdd = filesWithKeys.map(file => ({
                    file: file,
                    fileKey: file.fileKey
                }));
                const fileMetadata = filesWithKeys.map(file => ({
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    lastModified: file.lastModified,
                    fileKey: file.fileKey
                }));
                await this.addFilesToCharacterList(characterId, filesToAdd, fileMetadata);
                const removedMsg = duplicateFiles.length > 0 && action === 'remove' ? `, removed ${duplicateFiles.length} duplicate${duplicateFiles.length === 1 ? '' : 's'}` : '';
                this.showStatusMessage(`Added ${uniqueToAdd.length} file${uniqueToAdd.length === 1 ? '' : 's'}${removedMsg}`);
                event.target.value = '';
                return;
            }
            
            // Handle home list addition
            // Only add to home list if it's currently active AND character-specific mode allows it
            if (this.state.activeListType === 'home' && 
                (!this.state.isCharacterSpecificMode || this.state.fallbackToHome)) {
            // Create object URLs for new files (with progress tracking for large batches)
                if (filesWithKeys.length > 20) {
                    this.state.validationProgress = {
                        total: filesWithKeys.length,
                        completed: 0,
                        failed: 0,
                        currentFile: null
                    };
                }
                
                for (let i = 0; i < filesWithKeys.length; i++) {
                    const file = filesWithKeys[i];
                    if (filesWithKeys.length > 20 && this.state.validationProgress) {
                        this.state.validationProgress.currentFile = file.name;
                        this.state.validationProgress.completed = i;
                        this.updateValidationProgress();
                    }
                    const objectURL = URL.createObjectURL(file);
                    this.state.objectURLs.set(file, objectURL);
                    
                    // Small delay every 10 files to keep UI responsive
                    if ((i + 1) % 10 === 0 && i + 1 < filesWithKeys.length) {
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                }
                
                if (this.state.validationProgress) {
                    this.state.validationProgress.completed = filesWithKeys.length;
                    this.updateValidationProgress();
                }

            const oldLength = this.state.mediaFiles.length;
            const isFirstTime = oldLength === 0;
                const wasPlaying = this.state.isEnabled;
                this.state.mediaFiles = [...this.state.mediaFiles, ...filesWithKeys];
            
            // If this is the first time adding files, reset index and ensure paused state
            if (isFirstTime) {
                this.state.currentIndex = 0;
                if (this.state.isShuffleMode) {
                    this.reshuffleIndices();
                    this.state.currentIndex = this.state.shuffledIndices?.[0] ?? 0;
                }
                this.state.isEnabled = false;
                } else if (wasPlaying && this.state.mediaFiles.length > 0) {
                    // If was playing, continue playing with new files
                    this.state.isEnabled = true;
                    this.startMediaCycling();
                    if (this.elements.toggleBtn) {
                        this.updatePlayPauseIcon();
                        this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn playing';
                    }
                }
                
                // Update validation status to show new file count
                this.state.validationStatus = {
                    loaded: this.state.mediaFiles.length,
                    removed: 0
                };
                
                // Check storage capacity before saving (fallback browsers only)
                const canSave = await this.checkStorageBeforeAdd(filesWithKeys);
                if (!canSave) {
                    // Storage would exceed limit - remove files we just added
                    this.state.mediaFiles = this.state.mediaFiles.slice(0, oldLength);
                    // Clean up object URLs
                    filesWithKeys.forEach(file => {
                        const url = this.state.objectURLs.get(file);
                        if (url) {
                            URL.revokeObjectURL(url);
                            this.state.objectURLs.delete(file);
                        }
                    });
                    event.target.value = '';
                    return;
                }
                
                // Save files to IndexedDB as blobs (fallback method, chunked)
                await this.saveFileBlobsChunked(filesWithKeys, '');
                
                // Update storage capacity after saving
                await this.checkStorageCapacity();
                
                // Save metadata
                const fileMetadata = filesWithKeys.map(file => ({
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    lastModified: file.lastModified,
                    fileKey: file.fileKey
                }));
                await this.saveFileMetadata(fileMetadata);
                // Sync metadata to ensure it matches current state
                await this.syncHomeListMetadata();
                
                // Update UI to reflect new file count
            this.updateUIState();
            const removedMsg = duplicateFiles.length > 0 && action === 'remove' ? `, removed ${duplicateFiles.length} duplicate${duplicateFiles.length === 1 ? '' : 's'}` : '';
            this.showStatusMessage(`Added ${uniqueToAdd.length} new file${uniqueToAdd.length === 1 ? '' : 's'}${removedMsg}`);
            } else if (this.state.isCharacterSpecificMode && !this.state.fallbackToHome) {
                // Character-specific mode is on without fallback - Home list is disabled
                // Still save files for later use, but don't update current display (chunked)
                await this.saveFileBlobsChunked(filesWithKeys, '');
                const fileMetadata = filesWithKeys.map(file => ({
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    lastModified: file.lastModified,
                    fileKey: file.fileKey
                }));
                await this.saveFileMetadata(fileMetadata);
                // Sync metadata to ensure it matches current state
                await this.syncHomeListMetadata();
                
                // Update storage capacity after saving
                await this.checkStorageCapacity();
                
                this.showStatusMessage(`Home list is disabled. Files saved but not displayed. Character-specific mode is on without fallback.`);
            } else {
                // Files were selected but Home list is not active - save them anyway for later use (chunked)
                await this.saveFileBlobsChunked(filesWithKeys, '');
                const fileMetadata = filesWithKeys.map(file => ({
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    lastModified: file.lastModified,
                    fileKey: file.fileKey
                }));
                await this.saveFileMetadata(fileMetadata);
                // Sync metadata to ensure it matches current state
                await this.syncHomeListMetadata();
                
                // Update storage capacity after saving
                await this.checkStorageCapacity();
                const removedMsg = duplicateFiles.length > 0 && action === 'remove' ? `, removed ${duplicateFiles.length} duplicate${duplicateFiles.length === 1 ? '' : 's'}` : '';
                this.showStatusMessage(`Added ${uniqueToAdd.length} file${uniqueToAdd.length === 1 ? '' : 's'}${removedMsg} to Home list (not currently active)`);
            }

            event.target.value = '';
        }

        async saveFileBlobs(files, prefix = '') {
            if (!this.db) {
                this.debugWarn(`⚠️ ${EXTENSION_NAME}: Cannot save file blobs - IndexedDB not initialized`);
                return;
            }

            // Initialize progress tracking for saving (only show for large batches)
            if (files.length > 20 && this.state.validationProgress === null) {
                this.state.validationProgress = {
                    total: files.length,
                    completed: 0,
                    failed: 0,
                    currentFile: null
                };
            }

            return new Promise((resolve, reject) => {
                const transaction = this.db.transaction([CONFIG.INDEXEDDB_BLOB_STORE], 'readwrite');
                const store = transaction.objectStore(CONFIG.INDEXEDDB_BLOB_STORE);

                let completed = 0;
                let failed = 0;

                files.forEach((file, index) => {
                    // Update progress for large batches
                    if (files.length > 20 && this.state.validationProgress) {
                        this.state.validationProgress.currentFile = file.name;
                        this.state.validationProgress.completed = completed;
                        this.updateValidationProgress();
                    }

                    const prefixedKey = prefix + file.fileKey;
                    const dataToSave = {
                        fileKey: prefixedKey,
                        blob: file, // Store File/Blob object directly
                        originalKey: file.fileKey,
                        prefix: prefix || ''
                    };
                    
                    const request = store.put(dataToSave);

                    request.onsuccess = () => {
                        completed++;
                        if (files.length > 20 && this.state.validationProgress) {
                            this.state.validationProgress.completed = completed;
                            this.updateValidationProgress();
                        }
                        if (completed + failed === files.length) {
                            // Clear progress tracking
                            if (this.state.validationProgress) {
                                this.state.validationProgress = null;
                            }
                            if (failed === 0) {
                                this.debugLog(`💾 ${EXTENSION_NAME}: Saved ${completed} file blobs to IndexedDB (prefix: "${prefix}")`);
                                resolve();
                            } else {
                                this.debugError(`❌ ${EXTENSION_NAME}: Failed to save ${failed} out of ${files.length} blobs`);
                                reject(new Error(`Failed to save ${failed} blobs`));
                            }
                        }
                    };

                    request.onerror = () => {
                        failed++;
                        if (files.length > 20 && this.state.validationProgress) {
                            this.state.validationProgress.failed = failed;
                            this.state.validationProgress.completed = completed + failed;
                            this.updateValidationProgress();
                        }
                        this.debugWarn(`⚠️ ${EXTENSION_NAME}: Failed to save blob for ${file.fileKey}`);
                        if (completed + failed === files.length) {
                            // Clear progress tracking
                            if (this.state.validationProgress) {
                                this.state.validationProgress = null;
                            }
                            if (failed < files.length) {
                                resolve(); // Partial success
                            } else {
                                reject(request.error);
                            }
                        }
                    };
                });
            });
        }

        async saveFileBlobsChunked(files, prefix = '', chunkSize = 50) {
            if (!files || files.length === 0) {
                return;
            }

            const total = files.length;
            for (let i = 0; i < total; i += chunkSize) {
                const chunk = files.slice(i, i + chunkSize);
                await this.saveFileBlobs(chunk, prefix);

                // Small pause between batches to keep the UI responsive for very large imports
                if (i + chunkSize < total) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }
        }

        async saveFileMetadata(metadata) {
            try {
                // Prefer existing metadata from ST if available, else from localStorage
                let existingList = [];
                if (this.stContext?.extensionSettings?.[EXTENSION_NAME]?.fileMetadata) {
                    existingList = this.stContext.extensionSettings[EXTENSION_NAME].fileMetadata;
                } else {
                    const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.FILES);
                    if (saved) {
                        const data = JSON.parse(saved);
                        if (data.version === 3 && Array.isArray(data.metadata)) {
                            existingList = data.metadata;
                        }
                    }
                }
                const existingKeys = new Set(existingList.map(m => m.fileKey));
                const newMetadata = metadata.filter(m => !existingKeys.has(m.fileKey));
                const merged = [...existingList, ...newMetadata];

                // Write to ST extensionSettings when available
                if (this.stContext && this.stContext.extensionSettings) {
                    if (!this.stContext.extensionSettings[EXTENSION_NAME]) {
                        this.stContext.extensionSettings[EXTENSION_NAME] = {};
                    }
                    this.stContext.extensionSettings[EXTENSION_NAME].fileMetadata = merged;
                    if (typeof this.stContext.saveSettingsDebounced === 'function') {
                        this.stContext.saveSettingsDebounced();
                    }
                }

                // Always write to localStorage so metadata is available on next load (before stContext exists)
                localStorage.setItem(CONFIG.STORAGE_KEYS.FILES, JSON.stringify({ version: 3, metadata: merged }));
                this.debugLog(`💾 ${EXTENSION_NAME}: Saved file metadata`);
            } catch (e) {
                this.debugWarn('⚠️ Failed to save file metadata:', e);
            }
        }

        async syncHomeListMetadata() {
            const currentMetadata = this.state.mediaFiles.map(file => ({
                name: file.name,
                type: file.type,
                size: file.size,
                lastModified: file.lastModified,
                fileKey: file.fileKey || `${file.name}-${file.size}-${file.lastModified}`
            }));

            try {
                if (this.stContext && this.stContext.extensionSettings) {
                    if (!this.stContext.extensionSettings[EXTENSION_NAME]) {
                        this.stContext.extensionSettings[EXTENSION_NAME] = {};
                    }
                    this.stContext.extensionSettings[EXTENSION_NAME].fileMetadata = currentMetadata;
                    if (typeof this.stContext.saveSettingsDebounced === 'function') {
                        this.stContext.saveSettingsDebounced();
                    }
                }
                localStorage.setItem(CONFIG.STORAGE_KEYS.FILES, JSON.stringify({ version: 3, metadata: currentMetadata }));
                this.debugLog(`💾 ${EXTENSION_NAME}: Synced home list metadata (${currentMetadata.length} files)`);
            } catch (e) {
                this.debugWarn('⚠️ Failed to sync home list metadata:', e);
            }
        }

        async loadFileBlobs(prefix = '') {
            if (!this.db) return [];

            return new Promise((resolve, reject) => {
                const transaction = this.db.transaction([CONFIG.INDEXEDDB_BLOB_STORE], 'readonly');
                const store = transaction.objectStore(CONFIG.INDEXEDDB_BLOB_STORE);
                
                let request;
                if (prefix) {
                    const index = store.index('prefix');
                    request = index.getAll(prefix);
                } else {
                    // For Home list, get all blobs that don't have a character prefix
                    request = store.getAll();
                }

                request.onsuccess = () => {
                    let blobs = request.result;
                    
                    // If no prefix specified, filter out character-specific blobs (Home list only)
                    if (!prefix) {
                        blobs = blobs.filter(item => !item.prefix || item.prefix === '');
                    }
                    
                    // Map to return File objects with fileKey
                    const result = blobs.map(item => {
                        const file = item.blob;
                        // Ensure fileKey is set
                        if (!file.fileKey) {
                            file.fileKey = item.originalKey || item.fileKey.replace(prefix, '');
                        }
                        return file;
                    });
                    
                    this.debugLog(`📁 ${EXTENSION_NAME}: Loaded ${result.length} file blobs from IndexedDB${prefix ? ` (prefix: ${prefix})` : ' (Home list)'}`);
                    resolve(result);
                };

                request.onerror = () => {
                    this.debugError('❌ Failed to load file blobs:', request.error);
                    resolve([]); // Return empty array on error
                };
            });
        }

        async loadFileMetadata(characterId = null) {
            try {
                // If characterId is provided, load from character list metadata
                if (characterId) {
                    const charList = this.state.characterLists.get(characterId);
                    if (charList && charList.metadata) {
                        return charList.metadata;
                    }
                    return [];
                }
                
                // Otherwise load Home list metadata (from extensionSettings or localStorage)
                // Try ST extensionSettings first
                if (this.stContext && this.stContext.extensionSettings && 
                    this.stContext.extensionSettings[EXTENSION_NAME] &&
                    this.stContext.extensionSettings[EXTENSION_NAME].fileMetadata) {
                    const metadata = this.stContext.extensionSettings[EXTENSION_NAME].fileMetadata;
                    this.debugLog(`📁 ${EXTENSION_NAME}: Loaded ${metadata.length} file metadata from ST extensionSettings (Home list)`);
                    return metadata;
                }

                // Fallback to localStorage
                const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.FILES);
                if (saved) {
                    const data = JSON.parse(saved);
                    if (data.version === 3 && Array.isArray(data.metadata)) {
                        this.debugLog(`📁 ${EXTENSION_NAME}: Loaded ${data.metadata.length} file metadata from localStorage (Home list)`);
                        return data.metadata;
                    }
                }
            } catch (e) {
                this.debugWarn('⚠️ Failed to load file metadata:', e);
            }
            return [];
        }

        async clearSavedFiles(listType = 'home', characterId = null) {
            if (listType === 'character' && characterId) {
                // Clear character list
                if (this.state.characterLists.has(characterId)) {
                    const charList = this.state.characterLists.get(characterId);
                    // Clean up object URLs for character files
                    if (charList.files) {
                        charList.files.forEach(file => {
                            const url = this.state.objectURLs.get(file);
                            if (url) URL.revokeObjectURL(url);
                            this.state.objectURLs.delete(file);
                        });
                    }
                    
                    charList.files = [];
                    charList.metadata = [];
                    this.saveCharacterLists();
                    
                    // Clear character blobs from IndexedDB
                    if (this.db) {
                        try {
                            const prefix = `char_${characterId}_`;
                            const blobTransaction = this.db.transaction([CONFIG.INDEXEDDB_BLOB_STORE], 'readwrite');
                            const blobStore = blobTransaction.objectStore(CONFIG.INDEXEDDB_BLOB_STORE);
                            const blobIndex = blobStore.index('prefix');
                            
                            // Wait for transaction to complete
                            await new Promise((resolve, reject) => {
                                blobTransaction.oncomplete = () => resolve();
                                blobTransaction.onerror = () => reject(blobTransaction.error);
                                
                                const blobRequest = blobIndex.openCursor(IDBKeyRange.only(prefix));
                                blobRequest.onsuccess = (event) => {
                                    const cursor = event.target.result;
                                    if (cursor) {
                                        cursor.delete();
                                        cursor.continue();
                                    }
                                };
                                blobRequest.onerror = () => reject(blobRequest.error);
                            });
                        } catch (e) {
                            this.debugWarn(`⚠️ ${EXTENSION_NAME}: Failed to clear character blobs from IndexedDB:`, e);
                        }
                    }
                    
                    // If this is the active list, clear current state
                    if (this.state.activeListType === 'character' && this.state.currentCharacterId === characterId) {
            this.state.mediaFiles = [];
            this.state.currentIndex = 0;
                        this.cleanupObjectURLs();
                        this.updateUIState();
                        this.stopMediaCycling();
                        if (this.elements.container) this.elements.container.innerHTML = '';
                    }
                    
                    this.updateCharacterListUI();
                    this.showStatusMessage(`Cleared files for ${charList.name}`);
                    this.debugLog(`🗑️ ${EXTENSION_NAME}: Cleared files for character ${characterId}`);
                    
                    // Update storage capacity after clearing
            await this.checkStorageCapacity();
                }
                return;
            }
            
            // Clear home list
            // Only clear if we're currently viewing home list
            if (this.state.activeListType === 'home') {
                this.cleanupObjectURLs();
                this.state.mediaFiles = [];
                this.state.currentIndex = 0;
            }
            
            // Clear metadata storage
            try {
                // Try ST extensionSettings first
                if (this.stContext && this.stContext.extensionSettings && this.stContext.extensionSettings[EXTENSION_NAME]) {
                    delete this.stContext.extensionSettings[EXTENSION_NAME].fileMetadata;
                    if (typeof this.stContext.saveSettingsDebounced === 'function') {
                        this.stContext.saveSettingsDebounced();
                    }
                }
                // Also clear localStorage
                localStorage.removeItem(CONFIG.STORAGE_KEYS.FILES);
            } catch (e) {
                this.debugWarn(`⚠️ ${EXTENSION_NAME}: Failed to clear metadata:`, e);
            }
            
            // Clear IndexedDB - only Home list handles and blobs (no prefix)
            if (this.db) {
                try {
                    // Clear handles
                    const handleTransaction = this.db.transaction([CONFIG.INDEXEDDB_STORE], 'readwrite');
                    const handleStore = handleTransaction.objectStore(CONFIG.INDEXEDDB_STORE);
                    
                    await new Promise((resolve, reject) => {
                        handleTransaction.oncomplete = () => resolve();
                        handleTransaction.onerror = () => reject(handleTransaction.error);
                        
                        const handleRequest = handleStore.openCursor();
                        handleRequest.onsuccess = (event) => {
                            const cursor = event.target.result;
                            if (cursor) {
                                const item = cursor.value;
                                // Delete if no prefix or empty prefix (Home list)
                                if (!item.prefix || item.prefix === '') {
                                    cursor.delete();
                                }
                                cursor.continue();
                            }
                        };
                        handleRequest.onerror = () => reject(handleRequest.error);
                    });
                    
                    // Clear blobs
                    const blobTransaction = this.db.transaction([CONFIG.INDEXEDDB_BLOB_STORE], 'readwrite');
                    const blobStore = blobTransaction.objectStore(CONFIG.INDEXEDDB_BLOB_STORE);
                    
                    await new Promise((resolve, reject) => {
                        blobTransaction.oncomplete = () => resolve();
                        blobTransaction.onerror = () => reject(blobTransaction.error);
                        
                        const blobRequest = blobStore.openCursor();
                        blobRequest.onsuccess = (event) => {
                            const cursor = event.target.result;
                            if (cursor) {
                                const item = cursor.value;
                                // Delete if no prefix or empty prefix (Home list)
                                if (!item.prefix || item.prefix === '') {
                                    cursor.delete();
                                }
                                cursor.continue();
                            }
                        };
                        blobRequest.onerror = () => reject(blobRequest.error);
                    });
                } catch (e) {
                    this.debugWarn(`⚠️ ${EXTENSION_NAME}: Failed to clear Home list from IndexedDB:`, e);
                }
            }
            
            // Clear ST extensionSettings
            if (this.stContext && this.stContext.extensionSettings && this.stContext.extensionSettings[EXTENSION_NAME]) {
                delete this.stContext.extensionSettings[EXTENSION_NAME].fileMetadata;
                if (typeof this.stContext.saveSettingsDebounced === 'function') {
                    this.stContext.saveSettingsDebounced();
                }
            }
            
            this.updateUIState();
            this.stopMediaCycling();
            if (this.elements.container) this.elements.container.innerHTML = '';
            this.showStatusMessage('Home list cleared - please select new files');
            this.debugLog(`🗑️ ${EXTENSION_NAME}: Cleared Home list files`);
            
            // Sync metadata after clearing (should be empty now)
            await this.syncHomeListMetadata();
            this.updateHomeListStatus();
            
            // Update storage capacity after clearing
            await this.checkStorageCapacity();
        }

        cleanupObjectURLs() {
            this.state.objectURLs.forEach(url => URL.revokeObjectURL(url));
            this.state.objectURLs.clear();
        }

        startMediaCycling() {
            if (!this.state.isEnabled || this.state.mediaFiles.length === 0) return;
            
            this.debugLog('🔁 Starting automatic cycling');
            this.stopMediaCycling();
            
            // Ensure index is valid
            if (this.state.currentIndex >= this.state.mediaFiles.length) {
                this.state.currentIndex = 0;
            }
            if (this.state.currentIndex < 0) {
                this.state.currentIndex = 0;
            }
            
            // Reset start time when starting/restarting cycling
            this.state.mediaStartTime = Date.now();
            
            // Only show current media if it's not already showing (avoid unnecessary fade)
            // Check if current media exists and matches the current index
            const currentMediaIndex = this.state.currentMedia?.dataset?.targetIndex 
                ? parseInt(this.state.currentMedia.dataset.targetIndex, 10) 
                : null;
            // Only show media if there's no current media, or if the current media is showing a different index
            const needsToShowMedia = !this.state.currentMedia || 
                currentMediaIndex === null ||
                isNaN(currentMediaIndex) ||
                currentMediaIndex !== this.state.currentIndex;
            
            if (this.state.currentIndex < this.state.mediaFiles.length && needsToShowMedia) {
                this.showMedia(this.state.currentIndex);
            }
            this.scheduleNextMedia();
        }

        stopMediaCycling() {
            if (this.state.cycleTimeout) {
                clearTimeout(this.state.cycleTimeout);
                this.state.cycleTimeout = null;
                this.debugLog(`⏸️ ${EXTENSION_NAME}: Cycling paused`);
            }
            // Clear minimum duration timeout if it exists
            if (this.state.videoMinDurationTimeout) {
                clearTimeout(this.state.videoMinDurationTimeout);
                this.state.videoMinDurationTimeout = null;
            }
            // Also clear fade timeout if transitioning, but complete the transition to avoid stuck state
            if (this.state.fadeTimeout) {
                clearTimeout(this.state.fadeTimeout);
                this.state.fadeTimeout = null;
                // If there's a nextMedia waiting, complete the transition immediately to avoid stuck state
                if (this.state.nextMedia && this.state.isTransitioning) {
                    // Complete the transition immediately
                    if (this.state.currentMedia?.parentNode === this.elements.container) {
                        this.state.currentMedia.style.opacity = '0';
                        setTimeout(() => {
                            if (this.state.currentMedia?.parentNode === this.elements.container) {
                                this.elements.container.removeChild(this.state.currentMedia);
                            }
                            this.state.currentMedia = this.state.nextMedia;
                            this.state.nextMedia.style.opacity = '1';
                            this.state.nextMedia = null;
                            // Update currentIndex
                            const targetIndex = parseInt(this.state.currentMedia.dataset.targetIndex, 10);
                            if (!isNaN(targetIndex)) {
                                this.state.currentIndex = targetIndex;
                            }
                            this.state.isTransitioning = false;
                            // Re-enable buttons
                            if (this.elements.nextBtn) {
                                this.elements.nextBtn.disabled = false;
                            }
                            if (this.elements.prevBtn) {
                                this.elements.prevBtn.disabled = false;
                            }
                        }, 50);
                    } else {
                        // No current media, just set nextMedia as current
                        this.state.currentMedia = this.state.nextMedia;
                        this.state.nextMedia.style.opacity = '1';
                        this.state.nextMedia = null;
                        const targetIndex = parseInt(this.state.currentMedia.dataset.targetIndex, 10);
                        if (!isNaN(targetIndex)) {
                            this.state.currentIndex = targetIndex;
                        }
                        this.state.isTransitioning = false;
                        if (this.elements.nextBtn) {
                            this.elements.nextBtn.disabled = false;
                        }
                        if (this.elements.prevBtn) {
                            this.elements.prevBtn.disabled = false;
                        }
            }
                }
            }
            // Don't pause videos - pause is meant to stop cycling, not pause media playback
        }
        
        stopAndClearMedia() {
            // Comprehensive stop - clears everything for list switching
            this.stopMediaCycling();
            // Clear container immediately
            if (this.elements.container) {
                this.elements.container.innerHTML = '';
            }
            // Reset media state
            this.state.currentMedia = null;
            this.state.nextMedia = null;
            this.state.isTransitioning = false;
            this.state.mediaStartTime = null;
        }

        scheduleNextMedia() {
            if (!this.state.isEnabled || this.state.mediaFiles.length === 0) return;
            if (this.state.cycleTimeout) {
                clearTimeout(this.state.cycleTimeout);
            }
            
            // Determine duration based on the file at current index (not currentMedia, which might be old)
            // This ensures we use the correct duration for the media that's actually being displayed
            const currentFile = this.state.mediaFiles[this.state.currentIndex];
            if (!currentFile) return;
            
            const isVideo = this.isVideoFile(currentFile.name);
            let duration;
            
            if (isVideo) {
                if (this.state.playVideoUntilEnd) {
                    return;
                }
                const videoEl = this.state.currentMedia;
                const minMs = Math.max(2000, this.state.videoMinDuration);
                const maxMs = Math.max(2000, this.state.videoMaxDuration);
                if (videoEl && videoEl.tagName === 'VIDEO' && videoEl.duration && !isNaN(videoEl.duration)) {
                    const dSec = videoEl.duration;
                    const minS = minMs / 1000;
                    const maxS = maxMs / 1000;
                    if (dSec < minS) duration = minMs;
                    else if (dSec > maxS) duration = maxMs;
                    else duration = Math.round(dSec * 1000);
                } else {
                    return;
                }
            } else {
                // For images, use image duration
                duration = Math.max(2000, this.state.imageDuration);
            }
            
            // Track when this media started (or use current time if already playing)
            const now = Date.now();
            if (!this.state.mediaStartTime) {
                this.state.mediaStartTime = now;
            }
            
            // Calculate elapsed time
            const elapsed = now - this.state.mediaStartTime;
            
            // If media has already played longer than the new duration, advance immediately
            if (elapsed >= duration) {
                this.showNextMedia();
                return;
            }
            
            // Schedule timeout for remaining time
            const remaining = duration - elapsed;
            this.state.cycleTimeout = setTimeout(() => this.showNextMedia(), remaining);
        }

        handleNextMedia() {
            if (this.state.mediaFiles.length === 0) return;
            const now = Date.now();
            // Check if button is disabled or if we're transitioning
            // Reduced debounce to 100ms - button stays disabled until transition completes
            if (this.elements.nextBtn?.disabled || this.state.isTransitioning || (now - this.state.lastNextAt) < 100) return;
            this.state.lastNextAt = now;
            if (this.elements.nextBtn) {
                this.elements.nextBtn.disabled = true;
                // Don't re-enable here - let the transition completion handle it (in startFadeTransition)
            }
            const wasPlaying = this.state.isEnabled;
            this.stopMediaCycling();
            // Always update index and show media, even when paused
            this.state.mediaStartTime = Date.now();
            let nextIndex;
            if (this.state.isShuffleMode) {
                nextIndex = this.getNextIndex();
            } else {
                const len = this.state.mediaFiles.length;
                const baseIndex = this.getDisplayedIndex();
                nextIndex = (baseIndex + 1) % len;
            }
            this.showMedia(nextIndex);
            this.updateStatusDisplay(nextIndex);
            // Restore playback state if it was playing
            if (wasPlaying) {
                this.state.isEnabled = true;
                this.scheduleNextMedia();
            }
        }

        handlePrevMedia() {
            if (this.state.mediaFiles.length === 0) return;
            const now = Date.now();
            // Check if button is disabled or if we're transitioning
            // Reduced debounce to 100ms - button stays disabled until transition completes
            if (this.elements.prevBtn?.disabled || this.state.isTransitioning || (now - this.state.lastPrevAt) < 100) return;
            this.state.lastPrevAt = now;
            if (this.elements.prevBtn) {
                this.elements.prevBtn.disabled = true;
                // Don't re-enable here - let the transition completion handle it (in startFadeTransition)
            }
            const wasPlaying = this.state.isEnabled;
            this.stopMediaCycling();
            // Reset media start time for the new media
            this.state.mediaStartTime = Date.now();
            let prevIndex;
            if (this.state.isShuffleMode) {
                prevIndex = this.getPrevIndex();
            } else {
                const len = this.state.mediaFiles.length;
                const baseIndex = this.getDisplayedIndex();
                prevIndex = (baseIndex - 1 + len) % len;
            }
            this.showMedia(prevIndex);
            // Update status display like forward button does
            this.updateStatusDisplay(prevIndex);
            if (wasPlaying) {
                this.state.isEnabled = true;
                this.scheduleNextMedia();
                this.updatePlayPauseIcon();
                if (this.elements.toggleBtn) {
                    this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn playing';
                }
            }
        }

        getDisplayedIndex() {
            const len = this.state.mediaFiles.length;
            if (len === 0) return 0;
            const current = this.state.currentMedia;
            if (current?.dataset?.targetIndex != null) {
                const idx = parseInt(current.dataset.targetIndex, 10);
                if (!isNaN(idx) && idx >= 0 && idx < len) {
                    return idx;
                }
            }
            let idx = this.state.currentIndex ?? 0;
            if (idx < 0) idx = 0;
            if (idx >= len) idx = len - 1;
            return idx;
        }

        getNextIndex() {
            if (this.state.mediaFiles.length <= 1) return 0;
            const baseIndex = this.getDisplayedIndex();
            if (this.state.isShuffleMode) {
                // Build queue on first use or when exhausted
                if (!this.state.shuffledIndices || this.state.shuffleIndex >= this.state.shuffledIndices.length) {
                    this.reshuffleIndices();
                }
                const nextIndex = this.state.shuffledIndices[this.state.shuffleIndex];
                this.state.shuffleIndex++;
                return nextIndex;
            } else {
                return (baseIndex + 1) % this.state.mediaFiles.length;
            }
        }

        getPrevIndex() {
            if (this.state.mediaFiles.length <= 1) return 0;
            const baseIndex = this.getDisplayedIndex();
            if (this.state.isShuffleMode) {
                // For shuffle mode, we need to track history
                // If we don't have a queue or we're at the start, rebuild it
                if (!this.state.shuffledIndices || this.state.shuffledIndices.length === 0) {
                    this.reshuffleIndices();
                }
                
                // After a forward, "current" is at queue position shuffleIndex - 1. To go back we show position shuffleIndex - 2.
                if (this.state.shuffleIndex <= 1) {
                    // At or before first item: rebuild queue with current last, show second-to-last
                    this.reshuffleIndices();
                    if (this.state.shuffledIndices.length > 1) {
                        this.state.shuffleIndex = this.state.shuffledIndices.length - 2;
                        return this.state.shuffledIndices[this.state.shuffleIndex];
                    } else {
                        this.state.shuffleIndex = 0;
                        return this.state.shuffledIndices[0];
                    }
                } else {
                    this.state.shuffleIndex--;
                    return this.state.shuffledIndices[this.state.shuffleIndex - 1];
                }
            } else {
                return (baseIndex - 1 + this.state.mediaFiles.length) % this.state.mediaFiles.length;
            }
        }

        reshuffleIndices() {
            const total = this.state.mediaFiles.length;
            if (total === 0) { this.state.shuffledIndices = []; this.state.shuffleIndex = 0; return; }
            const all = Array.from({length: total}, (_, i) => i);
            const current = this.getDisplayedIndex();
            const others = all.filter(i => i !== current);
            // Fisher-Yates on others
            for (let i = others.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [others[i], others[j]] = [others[j], others[i]];
            }
            // Queue: all others first, then current last
            this.state.shuffledIndices = [...others, current];
            this.state.shuffleIndex = 0;
            this.debugLog(`🔀 ${EXTENSION_NAME}: Shuffled queue built (current last)`);
        }

        showNextMedia() {
            if (this.state.mediaFiles.length === 0) return;
            // Reset media start time for the new media
            this.state.mediaStartTime = Date.now();
            const nextIndex = this.getNextIndex();
            this.showMedia(nextIndex);
            // Only schedule next if enabled (auto-cycling)
            if (this.state.isEnabled) {
            this.scheduleNextMedia();
            }
            this.updateStatusDisplay(nextIndex);
        }

        showMedia(index) {
            if (!this.elements.container || index >= this.state.mediaFiles.length) return;
            
            // If stuck in transition state (timeout cleared but flags not reset), clean it up
            if (this.state.isTransitioning && this.state.nextMedia && !this.state.fadeTimeout) {
                // Complete the stuck transition immediately
                if (this.state.currentMediaWrapper?.parentNode === this.elements.container) {
                    this.state.currentMediaWrapper.style.opacity = '0';
                    setTimeout(() => {
                        if (this.state.currentMediaWrapper?.parentNode === this.elements.container) {
                            this.elements.container.removeChild(this.state.currentMediaWrapper);
                        }
                        this.state.currentMedia = this.state.nextMedia;
                        this.state.currentMediaWrapper = this.state.nextMediaWrapper;
                        this.state.nextMediaWrapper.style.opacity = '1';
                        this.state.nextMedia = null;
                        this.state.nextMediaWrapper = null;
                        const targetIndex = parseInt(this.state.currentMedia.dataset.targetIndex, 10);
                        if (!isNaN(targetIndex)) {
                            this.state.currentIndex = targetIndex;
                        }
                        this.state.isTransitioning = false;
                        if (this.elements.nextBtn) this.elements.nextBtn.disabled = false;
                        if (this.elements.prevBtn) this.elements.prevBtn.disabled = false;
                    }, 50);
                } else {
                    this.state.currentMedia = this.state.nextMedia;
                    this.state.currentMediaWrapper = this.state.nextMediaWrapper;
                    this.state.nextMediaWrapper.style.opacity = '1';
                    this.state.nextMedia = null;
                    this.state.nextMediaWrapper = null;
                    const targetIndex = parseInt(this.state.currentMedia.dataset.targetIndex, 10);
                    if (!isNaN(targetIndex)) {
                        this.state.currentIndex = targetIndex;
                    }
                    this.state.isTransitioning = false;
                    if (this.elements.nextBtn) this.elements.nextBtn.disabled = false;
                    if (this.elements.prevBtn) this.elements.prevBtn.disabled = false;
                }
                // Continue to show the new media after cleanup
            }
            
            // Prevent multiple rapid calls from creating multiple media elements
            if (this.state.isTransitioning && this.state.nextMedia && this.state.fadeTimeout) {
                // If already transitioning with active timeout, wait for it to complete
                return;
            }
            
            const mediaFile = this.state.mediaFiles[index];
            const objectURL = this.state.objectURLs.get(mediaFile);
            if (!objectURL) {
                this.debugError(`❌ ${EXTENSION_NAME}: No object URL found for file`);
                return;
            }
            
            const isVideo = this.isVideoFile(mediaFile.name);
            
            this.debugLog(`🎬 ${EXTENSION_NAME}: Showing ${isVideo ? 'video' : 'image'}: ${mediaFile.name}`);
            
            const mediaResult = isVideo ? this.createVideoElement(objectURL) : this.createImageElement(objectURL);
            const newMediaWrapper = mediaResult.wrapper;
            const newMedia = mediaResult.media;
            
            // Store the target index on the media element so we can update currentIndex when transition completes
            newMedia.dataset.targetIndex = index;
            
            // Set initial opacity on wrapper (which contains the media)
            newMediaWrapper.style.opacity = '0';
            newMediaWrapper.style.transition = `opacity ${CONFIG.FADE_DURATION}ms ease-in-out`;
            
            this.elements.container.appendChild(newMediaWrapper);
            this.state.nextMedia = newMedia;
            this.state.nextMediaWrapper = newMediaWrapper;
            
            this.startFadeTransition(newMediaWrapper, newMedia);
        }

        startFadeTransition(newMediaWrapper, newMedia) {
            if (this.state.fadeTimeout) {
                clearTimeout(this.state.fadeTimeout);
                this.state.fadeTimeout = null;
            }
            this.state.isTransitioning = true;

            if (this.state.currentMedia && this.state.currentMedia.tagName === 'VIDEO') {
                try {
                    this.state.currentMedia.muted = true;
                    this.state.currentMedia.pause();
                } catch (e) {}
            }

            setTimeout(() => {
                newMediaWrapper.style.opacity = '1';
                if (this.state.currentMediaWrapper) {
                    this.state.currentMediaWrapper.style.opacity = '0';
                }
                
                this.state.fadeTimeout = setTimeout(() => {
                    // Remove old wrapper (which contains old media)
                    if (this.state.currentMediaWrapper?.parentNode === this.elements.container) {
                        this.elements.container.removeChild(this.state.currentMediaWrapper);
                    }
                    
                    // Update state to new media
                    this.state.currentMedia = newMedia;
                    this.state.currentMediaWrapper = newMediaWrapper;
                    this.state.nextMedia = null;
                    this.state.nextMediaWrapper = null;
                    
                    // Update currentIndex only when transition completes to match what's actually showing
                    const targetIndex = parseInt(newMedia.dataset.targetIndex, 10);
                    if (!isNaN(targetIndex)) {
                        this.state.currentIndex = targetIndex;
                    }

                    // Only unmute if audio is both unlocked and enabled
                    if (this.state.isAudioUnlocked && this.state.isAudioEnabled && newMedia.tagName === 'VIDEO') {
                        try {
                            newMedia.muted = false;
                            newMedia.volume = this.state.volume;
                            newMedia.play().catch(() => {});
                        } catch (e) {}
                    } else if (newMedia.tagName === 'VIDEO') {
                        // Ensure video starts muted if audio is not enabled
                        try {
                            newMedia.muted = true;
                        } catch (e) {}
                    }

                    this.state.isTransitioning = false;
                    // Re-enable buttons after transition completes
                    if (this.elements.nextBtn) {
                        this.elements.nextBtn.disabled = false;
                    }
                    if (this.elements.prevBtn) {
                        this.elements.prevBtn.disabled = false;
                    }
                }, CONFIG.FADE_DURATION);
            }, 50);
        }

        createImageElement(imagePath) {
            // Create wrapper div for border
            const wrapper = this.createElement('div');
            wrapper.className = 'media-cycler-media-wrapper';
            wrapper.style.cssText = `
                position: absolute;
                border-radius: 8px;
                border: 1px solid var(--border-color, rgba(255, 255, 255, 0.3));
                box-sizing: border-box;
                overflow: hidden;
                pointer-events: none;
            `;
            
            const img = this.createElement('img');
            img.src = imagePath;
            img.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                object-fit: contain;
                transition: opacity ${CONFIG.FADE_DURATION}ms ease-in-out;
                pointer-events: none !important;
            `;
            
            img.onload = () => {
                this.debugLog(`✅ ${EXTENSION_NAME}: Image loaded successfully`);
                // Update wrapper size/position to match visible media
                this.updateMediaWrapperSize(wrapper, img);
            };
            img.onerror = () => {
                this.debugError(`❌ ${EXTENSION_NAME}: Failed to load image`);
                this.skipFailedMedia();
            };
            
            wrapper.appendChild(img);
            return { wrapper, media: img };
        }

        createVideoElement(videoPath) {
            // Create wrapper div for border
            const wrapper = this.createElement('div');
            wrapper.className = 'media-cycler-media-wrapper';
            wrapper.style.cssText = `
                position: absolute;
                border-radius: 8px;
                border: 1px solid var(--border-color, rgba(255, 255, 255, 0.3));
                box-sizing: border-box;
                overflow: hidden;
                pointer-events: none;
            `;
            
            const video = this.createElement('video');
            video.src = videoPath;
            video.autoplay = true;
            // Loop logic: if paused, always loop. If playing, loop only if "play until end" is disabled
            video.loop = !this.state.isEnabled || !this.state.playVideoUntilEnd;
            video.muted = true;
            video.playsInline = true;

            // Always start muted; unmute only when both unlocked + enabled
            this.debugLog('🔇 Video created muted');

            video.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                object-fit: contain;
                transition: opacity ${CONFIG.FADE_DURATION}ms ease-in-out;
                pointer-events: none !important;
            `;

            video.onerror = () => {
                this.debugError(`❌ ${EXTENSION_NAME}: Failed to load video`);
                this.skipFailedMedia();
            };
            
            // Update wrapper size when video metadata loads
            video.addEventListener('loadedmetadata', () => {
                this.updateMediaWrapperSize(wrapper, video);
                if (!this.state.isEnabled) return;

                const minMs = Math.max(2000, this.state.videoMinDuration);
                const maxMs = Math.max(2000, this.state.videoMaxDuration);
                const minS = minMs / 1000;
                const maxS = maxMs / 1000;
                const d = video.duration || 0;

                if (this.state.playVideoUntilEnd) {
                    this.state.videoPlayStartTime = Date.now();
                    if (d > 0 && d < 2) {
                        video.loop = true;
                        if (this.state.videoMinDurationTimeout) clearTimeout(this.state.videoMinDurationTimeout);
                        this.state.videoMinDurationTimeout = setTimeout(() => {
                            if (this.state.isEnabled && this.state.currentMedia === video) {
                                video.loop = false;
                                video.pause();
                                this.debugLog('🎬 Video played for minimum 2 seconds, moving to next media');
                                this.showNextMedia();
                            }
                        }, 2000);
                    } else {
                        video.loop = false;
                        video.addEventListener('ended', () => {
                            if (this.state.isEnabled && this.state.currentMedia === video) {
                                this.debugLog('🎬 Video ended, moving to next media');
                                this.showNextMedia();
                            }
                        }, { once: true });
                    }
                    return;
                }

                this.state.mediaStartTime = Date.now();
                if (this.state.cycleTimeout) {
                    clearTimeout(this.state.cycleTimeout);
                    this.state.cycleTimeout = null;
                }
                if (this.state.videoMinDurationTimeout) {
                    clearTimeout(this.state.videoMinDurationTimeout);
                    this.state.videoMinDurationTimeout = null;
                }
                if (d < minS) {
                    video.loop = true;
                    this.state.cycleTimeout = setTimeout(() => {
                        if (this.state.isEnabled && this.state.currentMedia === video) {
                            video.loop = false;
                            video.pause();
                            this.showNextMedia();
                        }
                    }, minMs);
                } else if (d > maxS) {
                    video.loop = false;
                    this.state.cycleTimeout = setTimeout(() => {
                        if (this.state.isEnabled && this.state.currentMedia === video) {
                            this.showNextMedia();
                        }
                    }, maxMs);
                } else {
                    video.loop = false;
                    video.addEventListener('ended', () => {
                        if (this.state.isEnabled && this.state.currentMedia === video) {
                            this.showNextMedia();
                        }
                    }, { once: true });
                }
            }, { once: true });
            
            wrapper.appendChild(video);
            return { wrapper, media: video };
        }

        updateMediaWrapperSize(wrapper, mediaElement) {
            // Calculate wrapper size/position to match visible media (accounting for object-fit: contain)
            if (!this.elements.container || !wrapper || !mediaElement) return;
            
            // Get media's natural dimensions
            const naturalWidth = mediaElement.naturalWidth || mediaElement.videoWidth || 0;
            const naturalHeight = mediaElement.naturalHeight || mediaElement.videoHeight || 0;
            
            if (naturalWidth === 0 || naturalHeight === 0) {
                // Media dimensions not available yet, try again after a short delay
                setTimeout(() => this.updateMediaWrapperSize(wrapper, mediaElement), 100);
                return;
            }
            
            const mediaAspectRatio = naturalWidth / naturalHeight;
            
            // Get container dimensions - use offsetWidth/offsetHeight for better performance during resize
            const containerWidth = this.elements.container.offsetWidth || this.elements.container.getBoundingClientRect().width;
            const containerHeight = this.elements.container.offsetHeight || this.elements.container.getBoundingClientRect().height;
            const containerAspectRatio = containerWidth / containerHeight;
            
            // Calculate displayed media size (with object-fit: contain)
            let displayedWidth, displayedHeight;
            if (containerAspectRatio > mediaAspectRatio) {
                // Container is wider - media height fills container
                displayedHeight = containerHeight;
                displayedWidth = containerHeight * mediaAspectRatio;
            } else {
                // Container is taller - media width fills container
                displayedWidth = containerWidth;
                displayedHeight = containerWidth / mediaAspectRatio;
            }
            
            // Calculate position to center the wrapper
            // But ensure wrapper doesn't extend into resize handle area (bottom-right 20x20px)
            const resizeHandleSize = 20;
            const maxWidth = containerWidth - resizeHandleSize;
            const maxHeight = containerHeight - resizeHandleSize;
            
            // Adjust displayed size if it would overlap resize handle
            if (displayedWidth > maxWidth) {
                displayedWidth = maxWidth;
                displayedHeight = displayedWidth / mediaAspectRatio;
            }
            if (displayedHeight > maxHeight) {
                displayedHeight = maxHeight;
                displayedWidth = displayedHeight * mediaAspectRatio;
            }
            
            const left = (containerWidth - displayedWidth) / 2;
            const top = (containerHeight - displayedHeight) / 2;
            
            // Update wrapper size and position
            wrapper.style.width = displayedWidth + 'px';
            wrapper.style.height = displayedHeight + 'px';
            wrapper.style.left = left + 'px';
            wrapper.style.top = top + 'px';
        }

        isVideoFile(filename) {
            // Handle both string filenames and File objects
            const name = typeof filename === 'string' ? filename : filename.name;
            const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
            return videoExtensions.some(ext => name.toLowerCase().endsWith(ext));
        }

        isValidMediaFile(file) {
            // Handle both File objects and string filenames
            const name = file.name?.toLowerCase() || (typeof file === 'string' ? file.toLowerCase() : '');
            const type = file.type || '';
            
            // Image MIME types
            const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 
                               'image/webp', 'image/bmp', 'image/svg+xml'];
            const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
            
            // Video MIME types
            const videoTypes = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 
                               'video/x-msvideo', 'video/x-matroska'];
            const videoExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.ogv'];
            
            // Check MIME type first (more reliable)
            if (type) {
                if (imageTypes.includes(type.toLowerCase())) {
                    return { valid: true, type: 'image' };
                }
                if (videoTypes.includes(type.toLowerCase())) {
                    return { valid: true, type: 'video' };
                }
            }
            
            // Fallback to extension check
            const allExts = [...imageExts, ...videoExts];
            for (const ext of allExts) {
                if (name.endsWith(ext)) {
                    return { 
                        valid: true, 
                        type: imageExts.includes(ext) ? 'image' : 'video' 
                    };
                }
            }
            
            return { valid: false, reason: 'Invalid file type - must be image or video' };
        }

        skipFailedMedia() {
            setTimeout(() => {
                if (this.state.isEnabled && this.state.mediaFiles.length > 0) this.showNextMedia();
            }, 1000);
        }

        updateUIState() {
            const hasFiles = this.state.mediaFiles.length > 0;
            if (this.elements.toggleBtn) this.elements.toggleBtn.disabled = !hasFiles;
            if (this.elements.nextBtn) this.elements.nextBtn.disabled = !hasFiles;
            if (this.elements.prevBtn) this.elements.prevBtn.disabled = !hasFiles;
            
            this.updateFileCountDisplay();
            this.updateStatusDisplay();
            
            if (hasFiles && this.elements.toggleBtn) {
                // Use updatePlayPauseIcon to set the icon instead of text
                this.updatePlayPauseIcon();
            }
        }

        updateFileCountDisplay() {
            if (!this.elements.fileCount) return;
            const count = this.state.mediaFiles.length;
            
            if (count === 0) {
                this.elements.fileCount.textContent = 'No media files';
                this.elements.fileCount.style.color = '';
            } else {
                this.elements.fileCount.textContent = `${count} file${count === 1 ? '' : 's'}`;
                this.elements.fileCount.style.color = '';
            }
        }

        async updateHomeListStatus() {
            if (!this.elements.homeListStatus) return;
            try {
                const metadata = await this.loadFileMetadata(null);
                const count = metadata.length;
                if (count === 0) {
                    this.elements.homeListStatus.textContent = 'No media files';
                } else {
                    this.elements.homeListStatus.textContent = `${count} file${count === 1 ? '' : 's'} ready`;
                }
            } catch (e) {
                this.debugWarn(`⚠️ ${EXTENSION_NAME}: Failed to update home list status:`, e);
                this.elements.homeListStatus.textContent = '';
            }
        }

        updateValidationProgress() {
            if (!this.elements.status || !this.state.validationProgress) return;
            
            const { total, completed, failed, currentFile } = this.state.validationProgress;
            const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
            const currentFileText = currentFile ? ` - ${currentFile}` : '';
            
            this.elements.status.textContent = `Validating files: ${completed}/${total} (${percentage}%)${currentFileText}`;
            this.elements.status.style.color = 'var(--accent-color, #4CAF50)';
            this.startStatusScroll();
        }

        formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
        }

        async calculateActualIndexedDBUsage() {
            // Calculate actual storage usage by summing all blob sizes in IndexedDB
            // This bypasses the browser's cached estimate
            if (!this.db) {
                this.debugWarn('💾 Cannot calculate IndexedDB usage - database not initialized');
                return 0;
            }

            return new Promise((resolve, reject) => {
                try {
                    const transaction = this.db.transaction([CONFIG.INDEXEDDB_BLOB_STORE], 'readonly');
                    const store = transaction.objectStore(CONFIG.INDEXEDDB_BLOB_STORE);
                    const request = store.openCursor();
                    
                    let totalSize = 0;
                    let count = 0;
                    
                    request.onsuccess = (event) => {
                        const cursor = event.target.result;
                        if (cursor) {
                            const item = cursor.value;
                            // Get blob size - blob is stored in the 'blob' property
                            if (item.blob) {
                                const size = item.blob.size || 0;
                                totalSize += size;
                                count++;
                            }
                            cursor.continue();
                        } else {
                            this.debugLog(`💾 Calculated actual IndexedDB usage: ${this.formatBytes(totalSize)} (${count} files)`);
                            resolve(totalSize);
                        }
                    };
                    
                    request.onerror = () => {
                        this.debugWarn('💾 Failed to calculate IndexedDB usage');
                        reject(request.error);
                    };
                } catch (e) {
                    this.debugWarn('💾 Error calculating IndexedDB usage:', e);
                    reject(e);
                }
            });
        }

        async checkStorageCapacity() {
            this.debugLog('💾 checkStorageCapacity() called');
            if (!navigator.storage || !navigator.storage.estimate) {
                this.debugWarn('⚠️ Storage API not available');
                return null;
            }

            try {
                // Get quota and total usage from browser estimate
                this.debugLog('💾 Calling navigator.storage.estimate() for quota and total usage...');
                const estimate = await navigator.storage.estimate();
                this.debugLog('💾 Storage estimate received:', estimate);
                
                const quota = estimate.quota || 0;
                const browserTotalUsage = estimate.usage || 0; // Total browser storage (may be stale)
                
                // Calculate our extension's actual usage from IndexedDB (accurate, immediate)
                this.debugLog('💾 Calculating actual IndexedDB usage (our extension only)...');
                let ourUsage = 0;
                try {
                    ourUsage = await this.calculateActualIndexedDBUsage();
                } catch (e) {
                    this.debugWarn('💾 Failed to calculate our usage, estimating from browser total:', e);
                    // If we can't calculate, we can't determine our portion
                    ourUsage = 0;
                }
                
                // Calculate accurate total usage by accounting for stale browser estimate
                // If browser estimate is stale, we can calculate: (browser total - our old usage) + our new usage
                const previousOurUsage = this.state.storageCapacity?.ourUsage || 0;
                const previousTotalUsage = this.state.storageCapacity?.totalUsage || browserTotalUsage;
                
                // Calculate "other" usage (everything except our extension)
                // If browser estimate seems stale (our usage changed but total didn't), use previous calculation
                const ourUsageChanged = Math.abs(ourUsage - previousOurUsage) > 1000000; // > 1MB change
                const totalUsageChanged = Math.abs(browserTotalUsage - previousTotalUsage) > 1000000;
                
                let calculatedTotalUsage;
                if (ourUsageChanged && !totalUsageChanged && previousTotalUsage > 0) {
                    // Browser estimate is stale - calculate accurate total
                    const otherUsage = previousTotalUsage - previousOurUsage;
                    calculatedTotalUsage = otherUsage + ourUsage;
                    this.debugLog(`💾 Browser estimate appears stale. Calculating: (${this.formatBytes(previousTotalUsage)} - ${this.formatBytes(previousOurUsage)}) + ${this.formatBytes(ourUsage)} = ${this.formatBytes(calculatedTotalUsage)}`);
                } else {
                    // Browser estimate is fresh or first check - use it
                    calculatedTotalUsage = browserTotalUsage;
                    this.debugLog(`💾 Using browser estimate for total usage: ${this.formatBytes(calculatedTotalUsage)}`);
                }
                
                const percentage = quota > 0 ? (calculatedTotalUsage / quota) * 100 : 0;

                this.state.storageCapacity = {
                    quota: quota,
                    usage: ourUsage, // Our extension's usage (for display)
                    totalUsage: calculatedTotalUsage, // Total browser storage (for quota checks)
                    ourUsage: ourUsage, // Keep track of our usage separately
                    percentage: percentage
                };

                this.debugLog(`💾 Storage: Our media ${this.formatBytes(ourUsage)} | Total browser ${this.formatBytes(calculatedTotalUsage)} / ${this.formatBytes(quota)} (${percentage.toFixed(1)}%)`);
                this.debugLog('💾 Calling updateStorageDisplay()...');
                this.updateStorageDisplay();
                this.debugLog('💾 updateStorageDisplay() completed');
                
                return this.state.storageCapacity;
            } catch (e) {
                this.debugError('⚠️ Failed to estimate storage:', e);
                return null;
            }
        }

        updateStorageDisplay() {
            this.debugLog('💾 updateStorageDisplay() called');
            
            if (!this.state.storageCapacity) {
                this.debugLog('💾 No storage capacity data - showing "Checking..." in tooltip');
                if (this.elements.storageIndicator) {
                    this.elements.storageIndicator.setAttribute('title', 'Storage: Checking...');
                }
                return;
            }
            
            const { usage, totalUsage, quota, percentage } = this.state.storageCapacity;
            const ourUsageText = this.formatBytes(usage);
            const totalUsageText = this.formatBytes(totalUsage);
            const quotaText = this.formatBytes(quota);
            
            // Update color based on usage
            let storageColor;
            if (percentage > 90) {
                storageColor = 'rgba(255, 87, 34, 1)'; // Red (changed from 95% to 90%)
                this.debugLog('💾 Storage color set to red (>90%)');
            } else if (percentage > 70) {
                storageColor = 'rgba(255, 152, 0, 1)'; // Orange (changed from 80% to 70%)
                this.debugLog('💾 Storage color set to orange (>70%)');
            } else {
                storageColor = 'var(--text-color, rgba(255,255,255,0.6))'; // Default
                this.debugLog('💾 Storage color set to default');
            }
            
            // Update circular storage indicator with tooltip
            this.updateStorageIndicator(percentage, storageColor, ourUsageText, quotaText);
            
            this.debugLog('💾 updateStorageDisplay() completed successfully');
        }
        
        updateStorageIndicator(percentage, color, ourUsageText = null, quotaText = null) {
            if (!this.elements.storageIndicator || !this.elements.storageProgressCircle) return;
            
            this.elements.storageIndicator.style.display = 'flex';
            
            // Calculate stroke-dasharray for circular progress (fills from bottom like Breath of the Wild)
            // The path is a full circle starting at 6 o'clock (M 10 18) and going clockwise
            // Circumference = 2 * π * r = 2 * π * 8 = ~50.27
            const circumference = 2 * Math.PI * 8; // r = 8 from SVG
            const filledLength = (percentage / 100) * circumference;
            
            // Since the path starts at 6 o'clock and goes clockwise, the dash will naturally
            // start filling from 6 o'clock going clockwise (6 -> 9 -> 12 -> 3 -> 6)
            // No offset needed - the path itself defines the start point
            this.elements.storageProgressCircle.style.strokeDasharray = `${filledLength} ${circumference}`;
            this.elements.storageProgressCircle.style.strokeDashoffset = `0`;
            this.elements.storageProgressCircle.style.stroke = color;
            
            // Update tooltip with simplified storage info
            if (ourUsageText && quotaText) {
                this.elements.storageIndicator.setAttribute('title', `${ourUsageText} / ${quotaText} (${percentage.toFixed(1)}%)`);
            } else {
                this.elements.storageIndicator.setAttribute('title', `Storage: ${percentage.toFixed(1)}%`);
            }
        }
        

        async checkStorageBeforeAdd(filesToAdd) {
            const capacity = this.state.storageCapacity;
                if (!capacity) {
                    // No capacity data yet - allow operation but suggest refreshing
                    this.debugLog('💾 No storage capacity data available - operation allowed. Refresh quota for accurate check.');
                    return true;
                }

                const totalSize = filesToAdd.reduce((sum, file) => sum + (file.size || 0), 0);
                // Use totalUsage (total browser storage) for quota checks, not just our usage
                const projectedTotalUsage = (capacity.totalUsage || capacity.usage) + totalSize;
                const projectedPercentage = (projectedTotalUsage / capacity.quota) * 100;

                this.debugLog(`💾 Storage check: Adding ${this.formatBytes(totalSize)}, projected total: ${this.formatBytes(projectedTotalUsage)} / ${this.formatBytes(capacity.quota)} (${projectedPercentage.toFixed(1)}%)`);

                // Warn if approaching limit
                if (projectedPercentage > 95) {
                    this.showStatusMessage(
                        `⚠️ Storage would exceed limit: ${this.formatBytes(projectedTotalUsage)} / ${this.formatBytes(capacity.quota)} ` +
                        `(${projectedPercentage.toFixed(1)}%). Files may not save.`
                    );
                    return false;
                } else if (projectedPercentage > 80) {
                    this.showStatusMessage(
                        `⚠️ Storage ${projectedPercentage.toFixed(1)}% full: ${this.formatBytes(projectedTotalUsage)} / ${this.formatBytes(capacity.quota)}.`
                    );
                }

                // Don't update the display - user can refresh manually if needed
            return true;
        }

        updateStatusDisplay(index = null) {
            if (!this.elements.status) return;
            
            // Show validation progress if active
            if (this.state.validationProgress) {
                this.updateValidationProgress();
                return;
            }
            
            // Show validation status only at startup (before any media has been shown)
            if (this.state.validationStatus && !this.state.isEnabled && this.state.mediaFiles.length > 0 && !this.state.currentMedia) {
                const { loaded, removed } = this.state.validationStatus;
                let statusText = '';
                if (removed > 0) {
                    statusText = `${removed} file${removed === 1 ? '' : 's'} removed (not found) | ${loaded} file${loaded === 1 ? '' : 's'} ready`;
                    this.elements.status.style.color = 'rgba(255, 152, 0, 1)';
                } else {
                    statusText = `${loaded} file${loaded === 1 ? '' : 's'} ready`;
                    this.elements.status.style.color = 'var(--accent-color, #4CAF50)';
                }
                
                this.elements.status.textContent = statusText;
                this.startStatusScroll();
                return;
            }
            
            // Normal status display - show current media position even when paused
            if (this.state.mediaFiles.length === 0) {
                this.elements.status.textContent = 'Click "Edit" to choose and delete media';
                this.elements.status.style.color = '';
                this.startStatusScroll();
            } else {
                // Use provided index, or nextMedia's target index, or currentIndex
                let displayIndex = index;
                if (displayIndex === null && this.state.nextMedia?.dataset.targetIndex) {
                    displayIndex = parseInt(this.state.nextMedia.dataset.targetIndex, 10);
                }
                if (displayIndex === null || isNaN(displayIndex)) {
                    displayIndex = this.state.currentIndex;
                }
                
                const currentFile = this.state.mediaFiles[displayIndex];
                if (!currentFile) return;
                const fileName = currentFile instanceof File ? currentFile.name : currentFile;
                const position = `${displayIndex + 1}/${this.state.mediaFiles.length}`;
                const isVideo = this.isVideoFile(fileName);
                this.elements.status.textContent = `${isVideo ? '[Video]' : '[Image]'} ${position} - ${fileName}`;
                this.elements.status.style.color = '';
                this.startStatusScroll();
            }
        }

        // Debug logging helper - only logs if debug is enabled
        debugLog(...args) {
            if (this.state.debugEnabled) {
                console.log(...args);
            }
        }
        
        debugWarn(...args) {
            if (this.state.debugEnabled) {
                console.warn(...args);
            }
        }
        
        debugError(...args) {
            if (this.state.debugEnabled) {
                console.error(...args);
            }
        }
        
        // Show tooltip notification at top of page
        showTooltipNotification(message, duration = 5000) {
            // Remove existing tooltip if any
            const existing = document.getElementById('media-cycler-tooltip');
            if (existing) {
                existing.remove();
            }
            
            const tooltip = document.createElement('div');
            tooltip.id = 'media-cycler-tooltip';
            tooltip.style.cssText = `
                position: fixed;
                top: 20px;
                left: 50%;
                transform: translateX(-50%);
                background: var(--media-cycler-bg, rgba(0,0,0,0.95));
                color: var(--text-color, white);
                padding: 12px 24px;
                border-radius: 8px;
                border: 1px solid var(--border-color, rgba(255,255,255,0.3));
                box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                z-index: 100000;
                font-size: 14px;
                font-weight: 500;
                text-align: center;
                pointer-events: none;
                animation: fadeInOut 0.3s ease-in;
            `;
            tooltip.textContent = message;
            
            // Add animation
            if (!document.getElementById('media-cycler-tooltip-style')) {
                const style = document.createElement('style');
                style.id = 'media-cycler-tooltip-style';
                style.textContent = `
                    @keyframes fadeInOut {
                        from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
                        to { opacity: 1; transform: translateX(-50%) translateY(0); }
                    }
                `;
                document.head.appendChild(style);
            }
            
            document.body.appendChild(tooltip);
            
            // Auto-remove after duration
            setTimeout(() => {
                if (tooltip.parentNode) {
                    tooltip.style.animation = 'fadeInOut 0.3s ease-out reverse';
                    setTimeout(() => tooltip.remove(), 300);
                }
            }, duration);
        }

        showStatusMessage(message) {
            if (!this.elements.status) return;
            // Clear validation status when showing a new message
            this.state.validationStatus = null;
            
            // Cancel any ongoing scroll animation
            if (this.state.statusScrollAnimation) {
                clearTimeout(this.state.statusScrollAnimation);
                this.state.statusScrollAnimation = null;
            }
            
            // Reset any scroll transforms and restore styles
            this.elements.status.style.transform = '';
            this.elements.status.style.transition = '';
            this.elements.status.style.textOverflow = 'ellipsis';
            this.elements.status.style.width = '';
            this.elements.status.style.maxWidth = '';
            this.elements.status.style.display = '';
            this.elements.status.style.textAlign = '';
            
            const originalText = this.elements.status.textContent;
            this.elements.status.textContent = message;
            this.elements.status.style.color = '';
            
            // Check if text needs scrolling and start animation
            this.startStatusScroll();
            
            setTimeout(() => this.updateStatusDisplay(), 3000);
        }
        
        startStatusScroll() {
            if (!this.elements.status) return;
            
            // Cancel any ongoing scroll animation
            if (this.state.statusScrollAnimation) {
                clearTimeout(this.state.statusScrollAnimation);
                this.state.statusScrollAnimation = null;
            }
            
            // Reset scroll state
            this.elements.status.style.transform = '';
            this.elements.status.style.transition = '';
            this.elements.status.style.textOverflow = 'ellipsis';
            this.elements.status.style.width = '';
            this.elements.status.style.maxWidth = '';
            this.elements.status.style.display = '';
            this.elements.status.style.textAlign = '';
            
            // Delay before starting scroll so user can see the beginning of the filename
            const scrollStartDelay = 800; // 800ms delay before scrolling starts
            
            setTimeout(() => {
                // Use requestAnimationFrame to ensure element is rendered
                requestAnimationFrame(() => {
                const statusEl = this.elements.status;
                
                // Get container width BEFORE changing element styles
                // Use parent container width as the visible area
                const parentContainer = statusEl.parentElement;
                const containerWidth = parentContainer ? parentContainer.offsetWidth : statusEl.offsetWidth;
                
                // Temporarily allow element to expand to show full text
                // Save original styles
                const originalTextOverflow = statusEl.style.textOverflow || 'ellipsis';
                const originalWidth = statusEl.style.width || '';
                const originalMaxWidth = statusEl.style.maxWidth || '';
                const originalDisplay = statusEl.style.display || '';
                const originalTextAlign = statusEl.style.textAlign || '';
                
                // Temporarily set to allow full text to render
                statusEl.style.textOverflow = 'clip';
                statusEl.style.width = 'auto';
                statusEl.style.maxWidth = 'none';
                statusEl.style.display = 'inline-block';
                statusEl.style.textAlign = 'left'; // Align left so text starts at left edge
                
                // Force a reflow to get accurate text width
                void statusEl.offsetWidth;
                
                const textWidth = statusEl.offsetWidth; // Use offsetWidth since we set width to auto
                
                // Only scroll if text is wider than container
                if (textWidth <= containerWidth) {
                    // Restore original styles - no transform needed, text fits
                    statusEl.style.textOverflow = originalTextOverflow;
                    statusEl.style.width = originalWidth;
                    statusEl.style.maxWidth = originalMaxWidth;
                    statusEl.style.display = originalDisplay;
                    statusEl.style.textAlign = originalTextAlign;
                    statusEl.style.transform = ''; // Clear any transform
                    return; // No scrolling needed
                }
                
                // Calculate the offset needed to match the original centered position
                // When text-align is center, the left edge of the text is at: (containerWidth - textWidth) / 2
                // This can be negative if text is wider than container (text extends beyond left edge)
                // We need to position the left-aligned text at this same position to prevent visual jump
                const centerOffset = (containerWidth - textWidth) / 2;
                const startOffset = centerOffset; // This matches where the text starts when centered
                
                // Apply the starting position immediately to prevent jump (only for text that needs scrolling)
                statusEl.style.transform = `translateX(${startOffset}px)`;
                
                // Keep styles that allow full text to be visible during scroll
                // The parent container's overflow: hidden will clip it
                
                // Calculate scroll distance - scroll the full text width so entire filename passes through
                // This ensures the beginning hides on the left while the end appears from the right
                // Start from the centered position and scroll to show the end
                const scrollDistance = textWidth - containerWidth; // Scroll enough to show the end
                const endPosition = startOffset - scrollDistance; // Final position after scrolling
                
                // Scroll speed: ~45px per second (readable pace, slightly slower)
                const scrollSpeed = 45; // pixels per second
                const duration = (scrollDistance / scrollSpeed) * 1000; // duration in milliseconds
                
                // Set up the scroll animation - animate from startOffset to endPosition
                statusEl.style.transition = `transform ${duration}ms linear`;
                statusEl.style.transform = `translateX(${endPosition}px)`;
                
                // Reset after animation completes
                this.state.statusScrollAnimation = setTimeout(() => {
                    statusEl.style.transition = '';
                    statusEl.style.transform = '';
                    statusEl.style.textOverflow = originalTextOverflow;
                    statusEl.style.width = originalWidth;
                    statusEl.style.maxWidth = originalMaxWidth;
                    statusEl.style.display = originalDisplay;
                    statusEl.style.textAlign = originalTextAlign;
                    this.state.statusScrollAnimation = null;
                }, duration);
                });
            }, scrollStartDelay);
        }

        togglePlayPause() {
            // Prevent playing home list when character-specific mode is on without fallback
            if (!this.state.isEnabled && this.state.activeListType === 'home') {
                if (this.state.isCharacterSpecificMode && !this.state.fallbackToHome) {
                    this.showStatusMessage('Cannot play home list - character-specific mode is on without fallback');
                    return;
                }
            }
            
            this.state.isEnabled = !this.state.isEnabled;
            
            // Clear validation status when user starts playing
            if (this.state.isEnabled) {
                this.state.validationStatus = null;
                // Update status display to show current file when play is pressed
                this.updateStatusDisplay();
                if (this.elements.toggleBtn) {
                this.updatePlayPauseIcon();
                this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn playing';
                }
                // Ensure media is visible when starting playback
                if (!this.state.isMediaVisible) {
                    this.state.isMediaVisible = true;
                    this.syncMediaVisibilityUI();
                }
                
                // If current media is a video and "play until end" is enabled, update loop and set up ended listener
                if (this.state.currentMedia?.tagName === 'VIDEO' && this.state.playVideoUntilEnd) {
                    const video = this.state.currentMedia;
                    // Track when this video started playing for minimum duration check
                    this.state.videoPlayStartTime = Date.now();
                    // Check if video duration is less than 2 seconds - if so, we'll loop until 2 seconds pass
                    const videoDuration = video.duration || 0;
                    if (videoDuration > 0 && videoDuration < 2) {
                        // Video is less than 2 seconds - enable looping temporarily
                        video.loop = true;
                        // Set up a timeout to move to next media after 2 seconds
                        if (this.state.videoMinDurationTimeout) {
                            clearTimeout(this.state.videoMinDurationTimeout);
                        }
                        this.state.videoMinDurationTimeout = setTimeout(() => {
                            if (this.state.isEnabled && this.state.currentMedia === video) {
                                video.loop = false;
                                video.pause();
                                this.debugLog('🎬 Video played for minimum 2 seconds, moving to next media');
                                this.showNextMedia();
                            }
                        }, 2000);
                    } else {
                        // Video is 2+ seconds - play until end normally
                        video.loop = false;
                        // Set up ended listener if not already present
                        video.addEventListener('ended', () => {
                            if (this.state.isEnabled && this.state.currentMedia === video) {
                                this.debugLog('🎬 Video ended, moving to next media');
                                this.showNextMedia();
                            }
                        }, { once: true });
                    }
                }
                
                this.startMediaCycling();
            } else {
                if (this.elements.toggleBtn) {
                this.updatePlayPauseIcon();
                this.elements.toggleBtn.className = 'menu-button media-cycler-btn media-cycler-toggle media-cycler-quick-action media-cycler-play-btn paused';
                }
                
                // If current media is a video and "play until end" is enabled, enable looping when paused
                if (this.state.currentMedia?.tagName === 'VIDEO' && this.state.playVideoUntilEnd) {
                    const video = this.state.currentMedia;
                    video.loop = true; // Enable looping when paused
                }
                
                this.stopMediaCycling();
            }
        }

        toggleMovableMode() {
            // Don't allow toggling movable mode during background mode
            if (this.state.isBackgroundMode) return;
            
            this.state.isMovableMode = !this.state.isMovableMode;
            this.updateMovableUI();
            
            if (this.state.isMovableMode) {
                this.showStatusMessage('Movable mode enabled - drag controls to reposition');
            } else {
                this.showStatusMessage('Movable mode disabled');
            }
        }

        toggleBackgroundMode() {
            if (!this.elements.container) return;
            
            this.state.isBackgroundMode = !this.state.isBackgroundMode;
            
            if (this.state.isBackgroundMode) {
                // Save current state
                const rect = this.elements.container.getBoundingClientRect();
                const computedStyle = window.getComputedStyle(this.elements.container);
                this.state.previousContainerState = {
                    left: computedStyle.left || rect.left + 'px',
                    top: computedStyle.top || rect.top + 'px',
                    width: computedStyle.width || rect.width + 'px',
                    height: computedStyle.height || rect.height + 'px',
                    right: computedStyle.right,
                    bottom: computedStyle.bottom,
                    zIndex: computedStyle.zIndex || '9998'
                };
                
                // Resize to full window - clear all positioning first
                this.elements.container.style.position = 'fixed';
                this.elements.container.style.left = '0';
                this.elements.container.style.top = '0';
                this.elements.container.style.right = '0';
                this.elements.container.style.bottom = '0';
                this.elements.container.style.width = '100vw';
                this.elements.container.style.height = '100vh';
                this.elements.container.style.maxWidth = '100vw';
                this.elements.container.style.maxHeight = '100vh';
                this.elements.container.style.margin = '0';
                this.elements.container.style.padding = '0';
                
                // Set z-index to low value so it's behind SillyTavern UI (true background)
                this.elements.container.style.zIndex = '1';
                
                // Disable movable and hover effects
                this.elements.container.classList.remove('movable-enabled', 'movable-dragging');
                this.elements.container.style.pointerEvents = 'auto'; // Keep pointer events for media
                this.elements.container.style.resize = 'none';
                
                // Update movable UI (will disable movable mode)
                this.updateMovableUI();
                
                // Update wrapper sizes after container is resized
                // Use requestAnimationFrame to ensure the container has been resized
                requestAnimationFrame(() => {
                    if (this.state.currentMediaWrapper && this.state.currentMedia) {
                        this.updateMediaWrapperSize(this.state.currentMediaWrapper, this.state.currentMedia);
                    }
                    if (this.state.nextMediaWrapper && this.state.nextMedia) {
                        this.updateMediaWrapperSize(this.state.nextMediaWrapper, this.state.nextMedia);
                    }
                });
                
                // Update button icon to enter icon (expanding arrows - fullscreen is ON)
                this.elements.backgroundModeBtn.innerHTML = this.elements.backgroundModeBtn.dataset.enterIcon;
                
                // Update button title
                this.elements.backgroundModeBtn.setAttribute('title', 'Background Mode: Click to exit fullscreen');
                
                this.showStatusMessage('Background mode enabled - fullscreen media');
                
                // Save background mode state
                this.saveAllSettings();
            } else {
                // Restore previous state
                if (this.state.previousContainerState) {
                    const prev = this.state.previousContainerState;
                    this.elements.container.style.left = prev.left || 'auto';
                    this.elements.container.style.top = prev.top || 'auto';
                    this.elements.container.style.right = prev.right || 'auto';
                    this.elements.container.style.bottom = prev.bottom || 'auto';
                    this.elements.container.style.width = prev.width || 'auto';
                    this.elements.container.style.height = prev.height || 'auto';
                    this.elements.container.style.maxWidth = '90vw';
                    this.elements.container.style.maxHeight = '100vh';
                    
                    // Restore original z-index
                    this.elements.container.style.zIndex = prev.zIndex || '9998';
                    
                    this.state.previousContainerState = null;
                }
                
                // Re-enable movable if it was enabled before
                this.updateMovableUI();
                
                // Update wrapper sizes after container is restored
                requestAnimationFrame(() => {
                    if (this.state.currentMediaWrapper && this.state.currentMedia) {
                        this.updateMediaWrapperSize(this.state.currentMediaWrapper, this.state.currentMedia);
                    }
                    if (this.state.nextMediaWrapper && this.state.nextMedia) {
                        this.updateMediaWrapperSize(this.state.nextMediaWrapper, this.state.nextMedia);
                    }
                });
                
                // Update button icon to exit icon (contracting arrows - fullscreen is OFF)
                this.elements.backgroundModeBtn.innerHTML = this.elements.backgroundModeBtn.dataset.exitIcon;
                
                // Update button title
                this.elements.backgroundModeBtn.setAttribute('title', 'Background Mode: Fullscreen media background');
                
                this.showStatusMessage('Background mode disabled');
                
                // Save background mode state
                this.saveAllSettings();
            }
        }

        applyBackgroundModeState() {
            // Apply saved background mode state (called on load)
            if (!this.elements.container || !this.state.isBackgroundMode) return;
            
            // Save current state before applying background mode
            const rect = this.elements.container.getBoundingClientRect();
            const computedStyle = window.getComputedStyle(this.elements.container);
            this.state.previousContainerState = {
                left: computedStyle.left || rect.left + 'px',
                top: computedStyle.top || rect.top + 'px',
                width: computedStyle.width || rect.width + 'px',
                height: computedStyle.height || rect.height + 'px',
                right: computedStyle.right,
                bottom: computedStyle.bottom,
                zIndex: computedStyle.zIndex || '9998'
            };
            
            // Resize to full window - clear all positioning first
            this.elements.container.style.position = 'fixed';
            this.elements.container.style.left = '0';
            this.elements.container.style.top = '0';
            this.elements.container.style.right = '0';
            this.elements.container.style.bottom = '0';
            this.elements.container.style.width = '100vw';
            this.elements.container.style.height = '100vh';
            this.elements.container.style.maxWidth = '100vw';
            this.elements.container.style.maxHeight = '100vh';
            this.elements.container.style.margin = '0';
            this.elements.container.style.padding = '0';
            
            // Set z-index to low value so it's behind SillyTavern UI (true background)
            this.elements.container.style.zIndex = '1';
            
            // Disable movable and hover effects
            this.elements.container.classList.remove('movable-enabled', 'movable-dragging');
            this.elements.container.style.pointerEvents = 'auto';
            this.elements.container.style.resize = 'none';
            
            // Update movable UI
            this.updateMovableUI();
            
            // Update wrapper sizes after container is resized
            requestAnimationFrame(() => {
                if (this.state.currentMediaWrapper && this.state.currentMedia) {
                    this.updateMediaWrapperSize(this.state.currentMediaWrapper, this.state.currentMedia);
                }
                if (this.state.nextMediaWrapper && this.state.nextMedia) {
                    this.updateMediaWrapperSize(this.state.nextMediaWrapper, this.state.nextMedia);
                }
            });
            
            // Update button icon and title
            if (this.elements.backgroundModeBtn) {
                this.elements.backgroundModeBtn.innerHTML = this.elements.backgroundModeBtn.dataset.enterIcon;
                this.elements.backgroundModeBtn.setAttribute('title', 'Background Mode: Click to exit fullscreen');
            }
        }

	updateMovableUI() {
            // Disable movable mode during background mode
            if (this.state.isBackgroundMode) {
                if (this.elements.circleContainer) {
                    this.elements.circleContainer.classList.remove('movable-enabled', 'movable-dragging', 'show-hover-border');
                }
                if (this.elements.container) {
                    this.elements.container.classList.remove('movable-enabled', 'movable-dragging');
                }
                return;
            }
            
            // Handle circle container (which is now the controls) - make it draggable
            if (this.elements.circleContainer) {
                if (this.state.isMovableMode) {
                    this.elements.circleContainer.classList.add('movable-enabled');
                    this.makeElementDraggable(this.elements.circleContainer, false);
                    
                    // Show green border when hovering over circle container or its children, but not small buttons
                    if (!this.elements.circleContainer.dataset.hoverHandlerAdded) {
                        const handleMouseEnter = () => {
                            this.elements.circleContainer.classList.add('show-hover-border');
                        };
                        const handleMouseLeave = () => {
                            this.elements.circleContainer.classList.remove('show-hover-border');
                        };
                        
                        // Prevent border when hovering over small buttons
                        const smallButtons = [
                            ...this.elements.circleContainer.querySelectorAll('.media-cycler-tab-btn'),
                            this.elements.storageIndicator,
                            this.elements.hideControlsEyeBtn,
                            this.elements.movableBtn,
                            this.elements.backgroundModeBtn
                        ].filter(btn => btn);
                        
                        smallButtons.forEach(btn => {
                            btn.addEventListener('mouseenter', () => {
                                this.elements.circleContainer.classList.remove('show-hover-border');
                            });
                            btn.addEventListener('mouseleave', () => {
                                this.elements.circleContainer.classList.add('show-hover-border');
                            });
                        });
                        
                        this.elements.circleContainer.addEventListener('mouseenter', handleMouseEnter);
                        this.elements.circleContainer.addEventListener('mouseleave', handleMouseLeave);
                        this.elements.circleContainer.dataset.hoverHandlerAdded = 'true';
                    }
                } else {
                    this.elements.circleContainer.classList.remove('movable-enabled', 'movable-dragging', 'show-hover-border');
                }
            }
            
            // Handle media container - make it draggable and resizable
            if (this.elements.container) {
                if (this.state.isMovableMode) {
                    // Convert any positioning (right/bottom or left/top) to explicit left/top for dragging
                    // Use getBoundingClientRect() which gives viewport coordinates for position:fixed elements
                    const rect = this.elements.container.getBoundingClientRect();
                    const computedStyle = window.getComputedStyle(this.elements.container);
                    
                    // Always convert to left/top when enabling movable mode to ensure consistent positioning
                    // getBoundingClientRect() gives viewport coordinates, which is correct for position:fixed
                    this.elements.container.style.left = rect.left + 'px';
                    this.elements.container.style.top = rect.top + 'px';
                    this.elements.container.style.right = 'auto';
                    this.elements.container.style.bottom = 'auto';
                    
                    this.elements.container.classList.add('movable-enabled');
                    this.elements.container.style.pointerEvents = 'auto';
                    this.makeElementDraggable(this.elements.container, false);
                    
                    // Update wrapper sizes during resize (throttled for performance)
                    let resizeUpdateTimeout;
                    let lastResizeUpdate = 0;
                    const updateWrappersOnResize = () => {
                        const now = Date.now();
                        // Throttle to max 60fps (16ms) for smooth updates
                        if (now - lastResizeUpdate < 16) {
                            clearTimeout(resizeUpdateTimeout);
                            resizeUpdateTimeout = setTimeout(updateWrappersOnResize, 16);
                            return;
                        }
                        lastResizeUpdate = now;
                        
                        // Update wrapper sizes immediately during resize
                        if (this.state.currentMediaWrapper && this.state.currentMedia) {
                            this.updateMediaWrapperSize(this.state.currentMediaWrapper, this.state.currentMedia);
                        }
                        if (this.state.nextMediaWrapper && this.state.nextMedia) {
                            this.updateMediaWrapperSize(this.state.nextMediaWrapper, this.state.nextMedia);
                        }
                    };
                    
                    // Track resize state - only true when user is actively resizing
                    let isResizing = false;
                    let resizeStartTime = 0;
                    let saveResizeTimeout;
                    
                    // Save positions when resize ends
                    const saveOnResizeEnd = () => {
                        clearTimeout(saveResizeTimeout);
                        saveResizeTimeout = setTimeout(() => {
                            this.saveAllSettings();
                            isResizing = false;
                            resizeStartTime = 0;
                        }, 500); // Debounce: save 500ms after resize ends
                    };
                    
                    // Track when resize actually starts (mousedown on resize handle)
                    const handleResizeStart = (e) => {
                        // Check if this is a resize handle interaction
                        const rect = this.elements.container.getBoundingClientRect();
                        const clickX = e.clientX - rect.left;
                        const clickY = e.clientY - rect.top;
                        const resizeHandleSize = 20;
                        const isInResizeHandle = 
                            clickX >= rect.width - resizeHandleSize && 
                            clickY >= rect.height - resizeHandleSize;
                        
                        if (isInResizeHandle) {
                            isResizing = true;
                            resizeStartTime = Date.now();
                            // Prevent drag from starting when clicking resize handle
                            e.stopPropagation();
                            e.stopImmediatePropagation();
                        }
                    };
                    
                    // Handle mouseup - only prevent events if we were actually resizing
                    const handleResizeEnd = (e) => {
                        if (isResizing) {
                            // Only prevent if we were actually resizing (not just a click)
                            // But don't stop propagation - let drag handler receive the event too
                            // The drag handler will check isDragging and handle it appropriately
                            if ((Date.now() - resizeStartTime) > 50) {
                                // Mark that we're ending a resize, but don't block other handlers
                                // The stopDrag function will still be called since we're not stopping propagation
                            }
                            saveOnResizeEnd();
                        }
                    };
                    
                    // Listen to resize events on the container - only update wrappers if actively resizing
                    const resizeObserver = new ResizeObserver(() => {
                        // Only update wrappers if user is actively resizing (not just on hover)
                        // ResizeObserver fires on any size change, but we only want to update during user-initiated resize
                        if (isResizing) {
                            updateWrappersOnResize();
                        }
                    });
                    resizeObserver.observe(this.elements.container);
                    
                    // Track resize start - use capture phase to run before drag handler
                    this.elements.container.addEventListener('mousedown', handleResizeStart, true);
                    // Handle resize end - use capture phase to run before other handlers
                    this.elements.container.addEventListener('mouseup', handleResizeEnd, true);
                    // Also save when user stops resizing (mouse leaves element)
                    this.elements.container.addEventListener('mouseleave', () => {
                        if (isResizing) {
                            saveOnResizeEnd();
                        }
                    });
                } else {
                    this.elements.container.classList.remove('movable-enabled', 'movable-dragging');
                    this.elements.container.style.pointerEvents = 'none';
                }
            }
            
            // Update lock/unlock icon
            if (this.elements.movableBtn) {
                const lockedIcon = this.elements.movableBtn.dataset.lockedIcon || '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
                const unlockedIcon = this.elements.movableBtn.dataset.unlockedIcon || '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 5-5 4.8 4.8 0 0 1 4 5"/></svg>';
                if (this.state.isMovableMode) {
                    this.elements.movableBtn.innerHTML = unlockedIcon;
                    this.elements.movableBtn.title = 'Lock (Disable Movable Mode)';
                } else {
                    this.elements.movableBtn.innerHTML = lockedIcon;
                    this.elements.movableBtn.title = 'Unlock (Enable Movable Mode)';
                }
            }
        }

	toggleShuffleMode() {
            this.state.isShuffleMode = !this.state.isShuffleMode;
            
            // Reset shuffle when turning on
            if (this.state.isShuffleMode) {
                this.state.shuffledIndices = null;
                this.state.shuffleIndex = 0;
            }
            
            // Save to unified settings
            this.saveAllSettings();
            this.updateShuffleUI();
            
            if (this.state.isShuffleMode) {
                this.showStatusMessage('Shuffle mode enabled - no repeats until all played!');
            } else {
                this.showStatusMessage('Shuffle mode disabled');
            }
        }

        updateShuffleUI() {
            if (this.elements.shuffleBtn) {
                if (this.state.isShuffleMode) {
                    this.elements.shuffleBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>';
                    this.elements.shuffleBtn.setAttribute('title', 'Shuffle On');
                    this.elements.shuffleBtn.classList.add('shuffle-active');
                    this.elements.shuffleBtn.style.opacity = '1';
                } else {
                    this.elements.shuffleBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>';
                    this.elements.shuffleBtn.setAttribute('title', 'Shuffle Off');
                    this.elements.shuffleBtn.classList.remove('shuffle-active');
                    this.elements.shuffleBtn.style.opacity = '1'; // Keep full opacity for tactile effect
                }
            }
        }

        updateVolumeIcon(volume) {
            if (!this.elements.volumeIcon) return;
            // Check if audio is enabled, not just volume level
            if (!this.state.isAudioEnabled || volume === 0) {
                // Muted icon
                this.elements.volumeIcon.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6"/></svg>';
                if (this.elements.volumeIcon.setAttribute) {
                    this.elements.volumeIcon.setAttribute('title', 'Unmute (click to enable audio)');
                }
            } else if (volume < 0.5) {
                // Low volume icon
                this.elements.volumeIcon.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 010 7.07"/></svg>';
                if (this.elements.volumeIcon.setAttribute) {
                    this.elements.volumeIcon.setAttribute('title', 'Mute (click to disable audio)');
                }
            } else {
                // High volume icon
                this.elements.volumeIcon.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>';
                if (this.elements.volumeIcon.setAttribute) {
                    this.elements.volumeIcon.setAttribute('title', 'Mute (click to disable audio)');
                }
            }
        }

        getContrastingColor(r, g, b, alpha = 0.95) {
            // Check if color is grayscale (R, G, B are similar)
            const avg = (r + g + b) / 3;
            const isGrayscale = Math.abs(r - avg) < 20 && Math.abs(g - avg) < 20 && Math.abs(b - avg) < 20;
            
            if (isGrayscale) {
                // For grayscale, calculate luminance (0 = black, 1 = white)
                const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                
                // Push towards white or black to avoid gray-on-gray
                if (luminance > 0.75) {
                    // Very light (0.75-1.0) → use black background
                    return `rgba(0, 0, 0, ${alpha})`;
                } else if (luminance < 0.25) {
                    // Very dark (0-0.25) → use white background
                    return `rgba(255, 255, 255, ${alpha})`;
                } else {
                    // Middle range (0.25-0.75) → interpolate between white and black
                    // Closer to 0.75 = darker background, closer to 0.25 = lighter background
                    const factor = (luminance - 0.25) / 0.5; // 0 at 0.25, 1 at 0.75
                    const bgValue = Math.round(255 * (1 - factor)); // 255 at 0.25, 0 at 0.75
                    return `rgba(${bgValue}, ${bgValue}, ${bgValue}, ${alpha})`;
                }
            } else {
                // For colored icons, use simple inversion
                const invertedR = 255 - r;
                const invertedG = 255 - g;
                const invertedB = 255 - b;
                return `rgba(${invertedR}, ${invertedG}, ${invertedB}, ${alpha})`;
            }
        }
        
        updatePlayPauseIcon() {
            if (!this.elements.toggleBtn) return;
            if (this.state.isEnabled) {
                // Pause icon (two bars) - playing state
                this.elements.toggleBtn.innerHTML = '<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>';
                this.elements.toggleBtn.setAttribute('title', 'Pause');
                this.elements.toggleBtn.classList.add('playing');
                this.elements.toggleBtn.classList.remove('paused');
                
                // Get icon color and calculate contrasting background
                requestAnimationFrame(() => {
                    const computedStyle = window.getComputedStyle(this.elements.toggleBtn);
                    const iconColor = computedStyle.color;
                    
                    // Parse icon color to get RGB and alpha
                    const rgbMatch = iconColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
                    if (rgbMatch) {
                        const r = parseInt(rgbMatch[1]);
                        const g = parseInt(rgbMatch[2]);
                        const b = parseInt(rgbMatch[3]);
                        const alpha = rgbMatch[4] ? parseFloat(rgbMatch[4]) : 0.95;
                        
                        // Calculate contrasting background
                        const bgColor = this.getContrastingColor(r, g, b, alpha);
                        
                        // Set background with !important to override theme CSS
                        this.elements.toggleBtn.style.setProperty('background', bgColor, 'important');
                        
                        // Create glow color (slightly brighter version of background)
                        const glowMatch = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
                        if (glowMatch) {
                            let glowR = parseInt(glowMatch[1]);
                            let glowG = parseInt(glowMatch[2]);
                            let glowB = parseInt(glowMatch[3]);
                            const glowAlpha = glowMatch[4] ? parseFloat(glowMatch[4]) : 0.8;
                            
                            // Calculate brightness of background
                            const bgBrightness = (glowR + glowG + glowB) / 3;
                            
                            // For very dark backgrounds (like black from white icon), use a white/light glow instead
                            if (bgBrightness < 30) {
                                // Black or very dark background - use white glow for visibility
                                glowR = 200;
                                glowG = 200;
                                glowB = 200;
                            } else if (bgBrightness < 50) {
                                // Very dark - make it much brighter so it's visible
                                glowR = Math.min(255, glowR + 100);
                                glowG = Math.min(255, glowG + 100);
                                glowB = Math.min(255, glowB + 100);
                            } else if (bgBrightness < 100) {
                                // Medium dark - moderate boost
                                glowR = Math.min(255, glowR + 50);
                                glowG = Math.min(255, glowG + 50);
                                glowB = Math.min(255, glowB + 50);
                            } else {
                                // Normal brightness - small boost
                                glowR = Math.min(255, glowR + 30);
                                glowG = Math.min(255, glowG + 30);
                                glowB = Math.min(255, glowB + 30);
                            }
                            
                            const glowColor = `rgba(${glowR}, ${glowG}, ${glowB}, ${glowAlpha})`;
                            
                            // Apply glow via box-shadow with !important (reduced size to avoid encroaching on adjacent buttons)
                            this.elements.toggleBtn.style.setProperty('box-shadow', `0 0 12px ${glowColor}, 0 0 24px ${glowColor}`, 'important');
                        }
                        
                        // Set hover state (slightly brighter background)
                        const hoverMatch = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
                        if (hoverMatch) {
                            const hoverR = Math.min(255, parseInt(hoverMatch[1]) + 20);
                            const hoverG = Math.min(255, parseInt(hoverMatch[2]) + 20);
                            const hoverB = Math.min(255, parseInt(hoverMatch[3]) + 20);
                            const hoverAlpha = hoverMatch[4] ? parseFloat(hoverMatch[4]) : 1;
                            const hoverBg = `rgba(${hoverR}, ${hoverG}, ${hoverB}, ${hoverAlpha})`;
                            
                            this.elements.toggleBtn.onmouseenter = () => {
                                if (this.elements.toggleBtn.classList.contains('playing')) {
                                    this.elements.toggleBtn.style.setProperty('background', hoverBg, 'important');
                                }
                            };
                            this.elements.toggleBtn.onmouseleave = () => {
                                if (this.elements.toggleBtn.classList.contains('playing')) {
                                    this.elements.toggleBtn.style.setProperty('background', bgColor, 'important');
                                }
                            };
                        }
                    }
                });
            } else {
                // Play icon (triangle) - paused/not started state
                this.elements.toggleBtn.innerHTML = '<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
                this.elements.toggleBtn.setAttribute('title', 'Play');
                this.elements.toggleBtn.classList.remove('playing');
                this.elements.toggleBtn.classList.add('paused');
                
                // Reset styles
                this.elements.toggleBtn.style.background = '';
                this.elements.toggleBtn.style.boxShadow = '';
                this.elements.toggleBtn.onmouseenter = null;
                this.elements.toggleBtn.onmouseleave = null;
            }
        }
	
        toggleControlsVisibility() {
            this.state.isUIVisible = !this.state.isUIVisible;
            this.updateUIVisibility();
            this.updateEyeButtons();
        }

        toggleMediaVisibility() {
            this.state.isMediaVisible = !this.state.isMediaVisible;
            this.syncMediaVisibilityUI();
            this.updateEyeButtons();
        }

        syncMediaVisibilityUI() {
            // Update container visibility
            if (this.elements.container) {
                this.elements.container.style.display = this.state.isMediaVisible ? 'block' : 'none';
            }
            
            // Update eye buttons
            this.updateEyeButtons();
        }

        updateUIVisibility() {
            if (this.elements.circleContainer) {
                // Use !important to ensure visibility is controlled by state
                this.elements.circleContainer.style.setProperty('display', this.state.isUIVisible ? 'flex' : 'none', 'important');
            }
            this.syncMediaVisibilityUI();
        }

        createMinimalUI() {
            if (!this.elements.minimalUI) {
                this.elements.minimalUI = this.createElement('div', {
                    className: 'media-cycler-minimal-ui'
                });
                this.elements.minimalUI.style.resize = 'none';
                this.elements.minimalUI.style.overflow = 'visible';
                // Set initial position at bottom left
                this.elements.minimalUI.style.bottom = '20px';
                this.elements.minimalUI.style.left = '20px';
                this.elements.minimalUI.style.top = 'auto';
                this.elements.minimalUI.style.right = 'auto';

                // Large closed eye button - shows controls when clicked
                this.elements.showAllBtn = this.createElement('button', {
                    className: 'media-cycler-btn media-cycler-show-all-btn',
                    style: 'font-size: 40px; padding: 0; line-height: 1; min-width: auto; border-radius: 50%; width: 64px; height: 64px; display: flex; align-items: center; justify-content: center; position: relative;',
                    title: 'Show Controls'
                });
                // Create closed eye SVG icon
                this.elements.showAllBtn.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
                this.elements.showAllBtn.addEventListener('click', () => {
                    // Show both controls UI and media UI
                    this.state.isUIVisible = true;
                    this.state.isMediaVisible = true;
                    this.updateUIVisibility();
                    
                    // Show the first media if available (but cycler stays paused)
                    // Show media regardless of isEnabled state - just display the current media
                    if (this.state.mediaFiles.length > 0 && this.state.currentIndex < this.state.mediaFiles.length) {
                        // If media is already showing, just ensure wrapper is updated
                        if (this.state.currentMedia && this.state.currentMediaWrapper) {
                            this.updateMediaWrapperSize(this.state.currentMediaWrapper, this.state.currentMedia);
                        } else {
                            this.showMedia(this.state.currentIndex);
                        }
                    }
                    
                    this.updateEyeButtons();
                });
                this.elements.minimalUI.appendChild(this.elements.showAllBtn);

                document.body.appendChild(this.elements.minimalUI);
                this.setupMinimalUIDrag();
            }
            this.updateEyeButtons();
        }

        updateEyeButtons() {
            // Update top right eye button visibility
            if (this.elements.hideControlsEyeBtn) {
                // Show when controls are visible (regardless of media visibility)
                this.elements.hideControlsEyeBtn.style.display = this.state.isUIVisible ? 'block' : 'none';
                // Update icon and title based on controls visibility state
                if (this.state.isUIVisible) {
                    const openEyeIcon = this.elements.hideControlsEyeBtn.dataset.openIcon;
                    // Controls are visible - show open eye, tooltip says to hide controls
                    this.elements.hideControlsEyeBtn.innerHTML = openEyeIcon;
                    this.elements.hideControlsEyeBtn.setAttribute('title', 'Click to hide controls');
                } else {
                    const closedEyeIcon = this.elements.hideControlsEyeBtn.dataset.closedIcon;
                    // Controls are hidden - show closed eye, tooltip says to show controls
                    this.elements.hideControlsEyeBtn.innerHTML = closedEyeIcon;
                    this.elements.hideControlsEyeBtn.setAttribute('title', 'Click to show controls');
                }
            }
            
            // Update bottom left closed eye button visibility
            // Always show when controls are hidden, always hide when controls are visible
            if (this.elements.minimalUI) {
                this.elements.minimalUI.style.display = !this.state.isUIVisible ? 'block' : 'none';
            }
        }

        setupMinimalUIDrag() {
            let isDragging = false;
            let startX, startY, startLeft, startTop;
            let hasMoved = false;
            const dragThreshold = 5;

            const startDrag = (e) => {
                // Don't drag if clicking the button itself
                if (e.target === this.elements.showAllBtn || e.target.closest('.media-cycler-show-all-btn')) {
                    return;
                }
                
                hasMoved = false;
                isDragging = false;
                
                // Convert bottom/left to top/left for dragging calculations
                const rect = this.elements.minimalUI.getBoundingClientRect();
                const currentBottom = window.innerHeight - rect.bottom;
                const currentLeft = rect.left;
                
                this.elements.minimalUI.style.top = rect.top + 'px';
                this.elements.minimalUI.style.left = currentLeft + 'px';
                this.elements.minimalUI.style.bottom = 'auto';
                this.elements.minimalUI.style.right = 'auto';
                
                startX = e.clientX;
                startY = e.clientY;
                startLeft = currentLeft;
                startTop = rect.top;
                
                document.addEventListener('mousemove', drag);
                document.addEventListener('mouseup', stopDrag);
            };

            const drag = (e) => {
                const deltaX = Math.abs(e.clientX - startX);
                const deltaY = Math.abs(e.clientY - startY);
                
                // If movement is significant, consider it a drag
                if (deltaX > dragThreshold || deltaY > dragThreshold) {
                    if (!isDragging) {
                        isDragging = true;
                        hasMoved = true;
                        this.elements.minimalUI.classList.add('movable-dragging');
                        e.preventDefault();
                    }
                    
                    if (isDragging) {
                        const newLeft = Math.max(0, Math.min(startLeft + (e.clientX - startX), window.innerWidth - this.elements.minimalUI.offsetWidth));
                        const newTop = Math.max(0, Math.min(startTop + (e.clientY - startY), window.innerHeight - this.elements.minimalUI.offsetHeight));
                        
                        // Convert back to bottom/left positioning
                        // Ensure bottom is never negative (clamp to reasonable range)
                        const newBottom = Math.max(0, Math.min(
                            window.innerHeight - newTop - this.elements.minimalUI.offsetHeight,
                            window.innerHeight - 10 // Keep at least 10px from bottom
                        ));
                        this.elements.minimalUI.style.left = newLeft + 'px';
                        this.elements.minimalUI.style.bottom = newBottom + 'px';
                        this.elements.minimalUI.style.top = 'auto';
                    }
                }
            };

            const stopDrag = (e) => {
                const wasDragging = isDragging;
                if (isDragging) {
                    this.elements.minimalUI.classList.remove('movable-dragging');
                    // Save positions after dragging ends
                    this.saveAllSettings();
                }
                isDragging = false;
                document.removeEventListener('mousemove', drag);
                document.removeEventListener('mouseup', stopDrag);
                
                // If we dragged, prevent any click events on buttons
                if (wasDragging && e && e.target && e.target.tagName === 'BUTTON') {
                    e.preventDefault();
                    e.stopPropagation();
                }
            };

            // Allow dragging from the container (not the button)
            this.elements.minimalUI.addEventListener('mousedown', startDrag);
            
            // Prevent button click if we dragged
            if (this.elements.showAllBtn) {
                this.elements.showAllBtn.addEventListener('click', (e) => {
                    if (hasMoved) {
                        e.preventDefault();
                        e.stopPropagation();
                        hasMoved = false;
                        return false;
                    }
                }, true);
            }
        }


        async saveFileList() {
            try {
                // Convert File objects to base64 for storage (fallback method)
                const filesData = [];
                for (const file of this.state.mediaFiles) {
                    try {
                        const arrayBuffer = await file.arrayBuffer();
                        const uint8Array = new Uint8Array(arrayBuffer);
                        
                        // Process in chunks to avoid "too many function arguments" error
                        // String.fromCharCode can only handle ~65535 arguments at once
                        const chunkSize = 8192;
                        let base64 = '';
                        for (let i = 0; i < uint8Array.length; i += chunkSize) {
                            const chunk = uint8Array.slice(i, i + chunkSize);
                            base64 += String.fromCharCode(...chunk);
                        }
                        base64 = btoa(base64);
                        
                        filesData.push({
                            name: file.name,
                            type: file.type,
                            lastModified: file.lastModified,
                            size: file.size,
                            data: base64
                        });
                    } catch (e) {
                        this.debugWarn(`⚠️ ${EXTENSION_NAME}: Failed to save file ${file.name}:`, e);
                    }
                }
                
                const dataToSave = {
                    version: 2,
                    files: filesData
                };
                
                localStorage.setItem(CONFIG.STORAGE_KEYS.FILES, JSON.stringify(dataToSave));
                this.debugLog(`💾 ${EXTENSION_NAME}: Saved ${filesData.length} files to base64 storage (fallback method)`);
            } catch (error) {
                this.debugError(`❌ ${EXTENSION_NAME}: Failed to save files:`, error);
                // If storage quota exceeded, warn user
                if (error.name === 'QuotaExceededError') {
                    this.showStatusMessage('Storage full - some files may not be saved');
                }
            }
        }


        getDebugTools() {
            return {
                version: EXTENSION_VERSION,
                enableMovable: () => {
                    this.state.isMovableMode = true;
                    this.updateMovableUI();
                    return 'Movable mode enabled';
                },
                disableMovable: () => {
                    this.state.isMovableMode = false;
                    this.updateMovableUI();
                    return 'Movable mode disabled';
                },
                enableShuffle: () => {
                    this.state.isShuffleMode = true;
                    this.updateShuffleUI();
                    return 'Shuffle enabled';
                },
                disableShuffle: () => {
                    this.state.isShuffleMode = false;
                    this.updateShuffleUI();
                    return 'Shuffle disabled';
                },
                debug: () => {
                    this.debugLog(`🔍 ${EXTENSION_NAME} Debug:`);
                    this.debugLog('  - Movable Mode:', this.state.isMovableMode);
                    this.debugLog('  - Shuffle Mode:', this.state.isShuffleMode);
                    this.debugLog('  - Files Count:', this.state.mediaFiles.length);
                    this.debugLog('  - Current Index:', this.state.currentIndex);
                    this.debugLog('  - Enabled:', this.state.isEnabled);
                    return `Movable: ${this.state.isMovableMode}, Shuffle: ${this.state.isShuffleMode}, Files: ${this.state.mediaFiles.length}, Enabled: ${this.state.isEnabled}`;
                },
                clearAll: () => {
                    this.clearSavedFiles();
                    localStorage.removeItem(CONFIG.STORAGE_KEYS.SHUFFLE);
                    localStorage.removeItem(CONFIG.STORAGE_KEYS.SETTINGS);
                    return 'All data cleared';
                }
            };
        }

        // Utility methods
        debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        }

        cleanup() {
            this.stopMediaCycling();
            if (this.state.fadeTimeout) {
                clearTimeout(this.state.fadeTimeout);
            }
            // Clean up intervals
            this.intervals.forEach(id => clearInterval(id));
            this.intervals = [];
            // Clean up observers
            this.observers.forEach(obs => obs.disconnect());
            this.observers = [];
            // Clean up object URLs to prevent memory leaks
            this.state.objectURLs.forEach(url => URL.revokeObjectURL(url));
            this.state.objectURLs.clear();
        }

        // ST Integration hooks
        handleChatChange() {
            // Optional: React to chat changes
            this.debugLog(`${EXTENSION_NAME}: Chat changed`);
        }

        handleCharacterChange() {
            // Optional: React to character selection
            this.debugLog(`${EXTENSION_NAME}: Character changed`);
        }
    }

    // Helper function to check if debug is enabled (for use outside class context)
    function isDebugEnabled() {
        try {
            const savedSettings = localStorage.getItem('mediaCycler_settings');
            if (savedSettings) {
                const settings = JSON.parse(savedSettings);
                return settings.debugEnabled === true;
            }
        } catch (e) {
            // Ignore errors
        }
        return false;
    }
    
    // Helper function for debug logging outside class context
    function debugLog(...args) {
        if (isDebugEnabled()) {
            console.log(...args);
        }
    }

    // Initialize extension when ST is ready
    let mediaCycler;

    function initializeExtension() {
        debugLog('🔧 Media Cycler: initializeExtension() called');
        debugLog('🔧 Media Cycler: extension_manager exists?', typeof extension_manager !== 'undefined');
        debugLog('🔧 Media Cycler: document.readyState:', document.readyState);
        
        if (!mediaCycler) {
            debugLog('🔧 Media Cycler: Creating new MediaCycler instance...');
            mediaCycler = new MediaCycler();
            mediaCycler.initialize().catch(console.error);
        } else {
            debugLog('🔧 Media Cycler: Instance already exists');
        }
        
    }

    // Audio toggle helpers
    MediaCycler.prototype.unlockAudioIfNeeded = function() {
        return new Promise((resolve) => {
            if (this.state.isAudioUnlocked) return resolve(true);
            try {
                const silentAudio = new Audio();
                silentAudio.src = 'data:audio/wav;base64,UklGRnoAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoAAAC';
                silentAudio.volume = 0.001;
                silentAudio.play().then(() => {
                    silentAudio.pause();
                    this.state.isAudioUnlocked = true;
                    resolve(true);
                }).catch(() => resolve(false));
            } catch (e) {
                resolve(false);
            }
        });
    };

    MediaCycler.prototype.toggleAudio = async function() {
        if (this.state.isAudioEnabled) {
            // Turn audio off
            this.state.isAudioEnabled = false;
            if (this.elements.audioBtn) this.elements.audioBtn.textContent = '🔇 Unmute';
            const current = this.state.currentMedia;
            if (current && current.tagName === 'VIDEO') {
                try { current.muted = true; } catch (e) {}
            }
            this.showStatusMessage('Audio muted');
            return;
        }

        // Turn audio on: unlock and try to unmute current
        const unlocked = await this.unlockAudioIfNeeded();
        this.state.isAudioEnabled = true;
        if (this.elements.audioBtn) this.elements.audioBtn.textContent = '🔊 Mute';

        const current = this.state.currentMedia;
        if (unlocked && current && current.tagName === 'VIDEO') {
            try {
                current.muted = false;
                current.volume = this.state.volume;
                await current.play().catch(() => {});
                this.showStatusMessage('Audio enabled');
                return;
            } catch (e) {}
        }
        // If cannot apply immediately, clarify it will apply on next video
        this.showStatusMessage('Audio enabled - will apply on next video');
    };

    // ST Extension Hook
    if (typeof module !== 'undefined' && module.exports) {
        // Node.js context
        module.exports = { MediaCycler };
    } else {
        // Browser context - wait for ST
        debugLog('🔧 Media Cycler: Setting up initialization...');
        if (document.readyState === 'loading') {
            debugLog('🔧 Media Cycler: Waiting for DOMContentLoaded...');
            document.addEventListener('DOMContentLoaded', initializeExtension);
        } else {
            debugLog('🔧 Media Cycler: DOM already loaded, initializing immediately...');
            initializeExtension();
        }
    }

})();
