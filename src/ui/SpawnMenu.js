import { PROPS } from '../props/PropRegistry.js';

const BTN_STYLE = `
    padding: 8px 14px; border: 2px solid #555; border-radius: 6px;
    background: rgba(0,0,0,0.7); color: #fff; font: 13px monospace;
    cursor: pointer; white-space: nowrap; user-select: none;
`;

/** HTML overlay spawn menu and tool bar */
export class SpawnMenu {
    constructor(main, tools) {
        this.main = main;
        this.tools = tools;
        this.isOpen = false;
        this.currentToolIndex = 0;
        this.activeTab = 'tools';
        this.onPropSelected = null;

        this.createDOM();
        this.selectTool(0);
    }

    createDOM() {
        // --- Bottom bar: compact buttons ---
        this.bottomBar = document.createElement('div');
        this.bottomBar.style.cssText = `
            position: fixed; bottom: 10px; left: 50%; transform: translateX(-50%);
            display: flex; gap: 6px; z-index: 2000; user-select: none;
        `;

        // Current tool button (shows active tool, click to open menu on Tools tab)
        this.toolBtn = document.createElement('button');
        this.toolBtn.style.cssText = BTN_STYLE;
        this.toolBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.activeTab = 'tools';
            this.toggle();
        });
        this.bottomBar.appendChild(this.toolBtn);

        // Props button (opens menu on Props tab)
        this.propsBtn = document.createElement('button');
        this.propsBtn.textContent = '📦 Props';
        this.propsBtn.style.cssText = BTN_STYLE;
        this.propsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.activeTab = 'props';
            this.toggle();
        });
        this.bottomBar.appendChild(this.propsBtn);

        document.body.appendChild(this.bottomBar);

        // --- Mobile action buttons (right side) ---
        this.isMobile = this.main.simulationParams.mobile;
        this.mobileActionArea = document.createElement('div');
        this.mobileActionArea.style.cssText = `
            position: fixed; right: 10px; bottom: 80px;
            display: ${this.isMobile ? 'flex' : 'none'};
            flex-direction: column; gap: 6px; z-index: 2000; user-select: none;
        `;
        document.body.appendChild(this.mobileActionArea);

        // Jump button (always present on mobile, left side)
        if(this.isMobile) {
            this.jumpBtn = document.createElement('button');
            this.jumpBtn.textContent = '⬆ Jump';
            this.jumpBtn.style.cssText = `
                position: fixed; left: 10px; bottom: 80px;
                padding: 14px 18px; border: 2px solid #555; border-radius: 10px;
                background: rgba(0,0,0,0.7); color: #fff; font: 15px monospace;
                cursor: pointer; user-select: none; z-index: 2000;
            `;
            this.jumpBtn.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this.main.player.jumpRequested = true;
            });
            document.body.appendChild(this.jumpBtn);
        }

        // --- Menu panel ---
        this.menuPanel = document.createElement('div');
        this.menuPanel.style.cssText = `
            position: fixed; bottom: 60px; left: 50%; transform: translateX(-50%);
            width: 420px; max-width: 92vw; max-height: 60vh; overflow-y: auto;
            background: rgba(20,20,30,0.95); border: 1px solid #444; border-radius: 10px;
            padding: 12px; z-index: 3000; display: none;
        `;

        // Tab bar
        this.tabBar = document.createElement('div');
        this.tabBar.style.cssText = 'display: flex; gap: 4px; margin-bottom: 10px;';

        this.toolsTabBtn = this.createTabButton('🔧 Tools', 'tools');
        this.propsTabBtn = this.createTabButton('📦 Props', 'props');
        this.tabBar.appendChild(this.toolsTabBtn);
        this.tabBar.appendChild(this.propsTabBtn);
        this.menuPanel.appendChild(this.tabBar);

        // Tools content
        this.toolsContent = document.createElement('div');
        this.toolsContent.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 6px;';
        this.tools.forEach((tool, i) => {
            let btn = document.createElement('button');
            btn.innerHTML = `<span style="font-size:20px">${tool.icon}</span> ${tool.name} <span style="color:#888;font-size:11px">[${i+1}]</span>`;
            btn.style.cssText = `
                padding: 10px; border: 2px solid #555; border-radius: 6px;
                background: rgba(50,50,60,0.8); color: #fff; font: 13px monospace;
                cursor: pointer; text-align: left;
            `;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectTool(i);
                this.close();
            });
            this.toolsContent.appendChild(btn);
            tool._menuBtn = btn;
        });
        this.menuPanel.appendChild(this.toolsContent);

        // Props content
        this.propsContent = document.createElement('div');
        this.propsContent.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 8px;';

        let cubeBtn = this.createPropButton('cube', 'Physics Cube', '📦');
        this.propsContent.appendChild(cubeBtn);
        PROPS.forEach(prop => {
            let btn = this.createPropButton(prop.id, prop.name, prop.icon || '📦');
            this.propsContent.appendChild(btn);
        });
        this.menuPanel.appendChild(this.propsContent);

        document.body.appendChild(this.menuPanel);

        // Tool name display (top center, always visible)
        this.toolLabel = document.createElement('div');
        this.toolLabel.style.cssText = `
            position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
            color: #fff; font: 14px monospace; background: rgba(0,0,0,0.5);
            padding: 4px 12px; border-radius: 4px; z-index: 2000;
            pointer-events: none;
        `;
        document.body.appendChild(this.toolLabel);
    }

    createTabButton(label, tabId) {
        let btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = `
            flex: 1; padding: 8px; border: none; border-radius: 4px;
            background: rgba(50,50,60,0.8); color: #fff; font: 13px monospace;
            cursor: pointer;
        `;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.activeTab = tabId;
            this.updateTabView();
        });
        return btn;
    }

    updateTabView() {
        if(this.activeTab === 'tools') {
            this.toolsContent.style.display = 'grid';
            this.propsContent.style.display = 'none';
            this.toolsTabBtn.style.background = 'rgba(68,170,255,0.3)';
            this.propsTabBtn.style.background = 'rgba(50,50,60,0.8)';
        } else {
            this.toolsContent.style.display = 'none';
            this.propsContent.style.display = 'grid';
            this.toolsTabBtn.style.background = 'rgba(50,50,60,0.8)';
            this.propsTabBtn.style.background = 'rgba(68,170,255,0.3)';
        }
    }

    createPropButton(propId, name, icon) {
        let btn = document.createElement('button');
        btn.style.cssText = `
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            padding: 8px 4px; border: 1px solid #555; border-radius: 6px;
            background: rgba(50,50,60,0.8); color: #fff; font: 11px monospace;
            cursor: pointer; min-height: 60px;
        `;
        btn.innerHTML = `<span style="font-size:24px">${icon}</span><span>${name}</span>`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if(this.onPropSelected) this.onPropSelected(propId);
            this.close();
        });
        return btn;
    }

    selectTool(index) {
        if(index < 0 || index >= this.tools.length) return;
        let prev = this.tools[this.currentToolIndex];
        if(prev._menuBtn) prev._menuBtn.style.borderColor = '#555';
        prev.onUnequip(this.main);

        this.currentToolIndex = index;
        let tool = this.tools[index];
        if(tool._menuBtn) tool._menuBtn.style.borderColor = '#44aaff';
        tool.onEquip(this.main);
        this.toolLabel.textContent = `${tool.icon} ${tool.name}`;
        this.toolBtn.textContent = `${tool.icon} ${tool.name}`;
        this.updateMobileActions(tool);
    }

    updateMobileActions(tool) {
        if(!this.isMobile) return;
        this.mobileActionArea.innerHTML = '';
        for(let action of tool.mobileActions) {
            let btn = document.createElement('button');
            btn.innerHTML = `${action.icon}<br><span style="font-size:10px">${action.label}</span>`;
            btn.style.cssText = `
                padding: 12px 16px; border: 2px solid #555; border-radius: 10px;
                background: rgba(0,0,0,0.7); color: #fff; font: 14px monospace;
                cursor: pointer; text-align: center; min-width: 60px;
            `;
            btn.addEventListener('touchstart', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if(action.action === 'primary') {
                    tool.onPrimaryFire(this.main);
                } else if(action.action === 'secondary') {
                    tool.onSecondaryFire(this.main);
                } else if(action.action === 'scrollUp') {
                    tool.onScroll(this.main, -120);
                } else if(action.action === 'scrollDown') {
                    tool.onScroll(this.main, 120);
                }
            });
            this.mobileActionArea.appendChild(btn);
        }
    }

    getCurrentTool() {
        return this.tools[this.currentToolIndex];
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }

    open() {
        this.isOpen = true;
        this.menuPanel.style.display = 'block';
        this.updateTabView();
        if(this.main.player.controls) this.main.player.controls.unlock();
    }

    close() {
        this.isOpen = false;
        this.menuPanel.style.display = 'none';
    }
}
