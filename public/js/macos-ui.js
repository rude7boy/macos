// ============================================
// 🍎 SCRIPTS macOS - Funcionalidades do Design
// ============================================

// ============================================
// 1. TOGGLE DE TEMA (CLARO/ESCURO)
// ============================================
function initThemeToggle() {
    const themeToggle = document.getElementById('macos-theme-toggle');
    const iconDark = document.getElementById('macos-theme-icon-dark');
    const iconLight = document.getElementById('macos-theme-icon-light');

    if (!themeToggle || !iconDark || !iconLight) return;

    // Carregar tema salvo
    const savedTheme = localStorage.getItem('theme') || 'dark';
    if (savedTheme === 'light') {
        document.documentElement.classList.add('light');
        document.body.classList.add('light');
        themeToggle.checked = true;
        iconDark.style.display = 'none';
        iconLight.style.display = 'block';
    }

    // Event listener para mudança de tema
    themeToggle.addEventListener('change', () => {
        if (themeToggle.checked) {
            document.documentElement.classList.add('light');
            document.body.classList.add('light');
            localStorage.setItem('theme', 'light');
            iconDark.style.display = 'none';
            iconLight.style.display = 'block';
        } else {
            document.documentElement.classList.remove('light');
            document.body.classList.remove('light');
            localStorage.setItem('theme', 'dark');
            iconDark.style.display = 'block';
            iconLight.style.display = 'none';
        }
    });
}

// ============================================
// 2. TRAFFIC LIGHTS (BOTÕES DE CONTROLE)
// ============================================
function initTrafficLights() {
    // Botão de fechar (vermelho) - Volta para home
    const closeButtons = document.querySelectorAll('.macos-traffic-light.close');
    closeButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Ignora se estiver dentro de um modal
            if (btn.closest('.macos-modal-overlay')) return;

            if (window.location.pathname !== '/') {
                window.location.href = '/';
            }
        });
        btn.style.cursor = 'pointer';
    });

    // Botão de minimizar (amarelo) - Scroll para topo
    const minimizeButtons = document.querySelectorAll('.macos-traffic-light.minimize');
    minimizeButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Ignora se estiver dentro de um modal - mas permite se quisermos minimizar o modal (futuro)
            if (btn.closest('.macos-modal-overlay')) return;

            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        btn.style.cursor = 'pointer';
    });

    // Botão de maximizar (verde) - Toggle fullscreen
    const maximizeButtons = document.querySelectorAll('.macos-traffic-light.maximize');
    maximizeButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Ignora se estiver dentro de um modal
            if (btn.closest('.macos-modal-overlay')) return;

            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen();
            } else {
                document.exitFullscreen();
            }
        });
        btn.style.cursor = 'pointer';
    });
}

// ============================================
// 3. PROFILE POPUP
// ============================================
function initProfilePopup() {
    const profileBtn = document.getElementById('macosProfileBtn');
    const profilePopup = document.getElementById('macosProfilePopup');

    if (!profileBtn || !profilePopup) return;

    profileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        profilePopup.style.display = profilePopup.style.display === 'none' ? 'block' : 'none';
    });

    document.addEventListener('click', (e) => {
        if (profilePopup.style.display !== 'none' &&
            !profilePopup.contains(e.target) &&
            !profileBtn.contains(e.target)) {
            profilePopup.style.display = 'none';
        }
    });
}

// ============================================
// 4. SIDEBAR ACTIVE STATE
// ============================================
function initSidebarActiveState() {
    const currentPath = window.location.pathname;
    const currentHash = window.location.hash;
    const sidebarItems = document.querySelectorAll('.macos-sidebar-item');

    sidebarItems.forEach(item => {
        const href = item.getAttribute('href');

        // Verificar se é a página atual
        if (href === currentPath || (href && href.includes('#') && href === currentPath + currentHash)) {
            item.classList.add('active');
        }

        // Adicionar listener para marcar como ativo ao clicar
        item.addEventListener('click', () => {
            sidebarItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
        });
    });
}

// ============================================
// 5. HABILITAR AUTOCAPITALIZE
// ============================================
function enableAutocapitalize() {
    document.querySelectorAll('input[type="text"], input[type="email"], input[type="search"], textarea').forEach(element => {
        element.setAttribute('autocapitalize', 'words');
    });
}

// ============================================
// 6. INICIALIZAR TUDO
// ============================================
window.initMacOSUI = function() {
    initThemeToggle();
    initTrafficLights();
    initProfilePopup();
    initSidebarActiveState();
    enableAutocapitalize();
    console.log('🍎 macOS UI initialized/refreshed');
};

document.addEventListener('DOMContentLoaded', () => {
    window.initMacOSUI();

    // Observar mudanças no DOM para novos inputs
    const observer = new MutationObserver(enableAutocapitalize);
    observer.observe(document.body, { childList: true, subtree: true });
});
