/**
 * Set up repeater autofill list, and make dropdown active
 *
 * This fills the dataset from the dropdown, and make each dropdown element set
 * the value in the input field.
 */
function setRepeaterList() {
    let input = document.querySelector("#repeater")
    let datalist = document.querySelector("datalist#repeater-list")
    let repeaterList = document.querySelector("#stock-repeaters .dropdown-content")

    // If the element doesn't exist, skip this setup
    if (!repeaterList) {
        return
    }

    for (let a of repeaterList.children) {
        if (a.tagName == "A") {
            let opt = datalist.appendChild(document.createElement("option"))
            if (a.dataset.value != undefined) {
                opt.value = a.dataset.value
            }
            opt.textContent = a.textContent

            a.addEventListener(
                "click",
                () => {
                    input.value = opt.value
                    input.dispatchEvent(new Event("change"))
                },
            )
        }
    }
}

function setupTabs() {
    // Setup tab switching for Morse/Text Chat tabs
    const tabs = document.querySelectorAll('.tabs li[data-tab]')

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTabId = tab.getAttribute('data-tab')

            // Remove active class from all tabs
            tabs.forEach(t => t.classList.remove('is-active'))

            // Add active class to clicked tab
            tab.classList.add('is-active')

            // Clear notification indicator when switching to text chat tab
            if (targetTabId === 'text-tab') {
                tab.classList.remove('has-notification')
            }

            // Hide all tab contents
            document.querySelectorAll('.tab-content').forEach(content => {
                content.style.display = 'none'
            })

            // Show selected tab content
            const targetContent = document.getElementById(targetTabId)
            if (targetContent) {
                targetContent.style.display = 'block'
            }
        })
    })
}

function setupSettingsDropdown() {
    const dropdown = document.querySelector('#settings-dropdown')
    const toggle = document.querySelector('#settings-toggle')

    if (!dropdown || !toggle) {
        return
    }

    // Toggle dropdown on click
    toggle.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        dropdown.classList.toggle('is-active')
    })

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target)) {
            dropdown.classList.remove('is-active')
        }
    })

    // Prevent closing when clicking inside the dropdown content
    const dropdownContent = document.querySelector('.settings-dropdown-content')
    if (dropdownContent) {
        dropdownContent.addEventListener('click', (e) => {
            e.stopPropagation()
        })
    }
}

function setupNavbarBurger() {
    // Mobile navbar burger menu toggle
    const burger = document.querySelector('#navbar-burger')
    const menu = document.querySelector('#navbar-menu')

    if (!burger || !menu) {
        return
    }

    burger.addEventListener('click', () => {
        burger.classList.toggle('is-active')
        menu.classList.toggle('is-active')
    })
}

function setupVisibilityToggles() {
    // Setup toggle for charts visibility
    const chartsToggle = document.querySelector('#toggle-charts')
    const chartsContainer = document.querySelector('#charts')

    if (chartsToggle && chartsContainer) {
        // Restore saved state from localStorage
        const chartsVisible = localStorage.getItem('chartsVisible') !== 'false'
        if (!chartsVisible) {
            chartsContainer.style.display = 'none'
            const icon = chartsToggle.querySelector('i')
            icon.classList.remove('mdi-eye')
            icon.classList.add('mdi-eye-off')
        }

        chartsToggle.addEventListener('click', () => {
            const isVisible = chartsContainer.style.display !== 'none'
            chartsContainer.style.display = isVisible ? 'none' : 'block'

            // Update icon
            const icon = chartsToggle.querySelector('i')
            if (isVisible) {
                icon.classList.remove('mdi-eye')
                icon.classList.add('mdi-eye-off')
            } else {
                icon.classList.remove('mdi-eye-off')
                icon.classList.add('mdi-eye')
            }

            // Save state
            localStorage.setItem('chartsVisible', !isVisible)
        })
    }

    // Setup toggle for user list visibility
    const userListToggle = document.querySelector('#toggle-user-list')
    const userList = document.querySelector('#user-list')

    if (userListToggle && userList) {
        // Restore saved state from localStorage
        const userListVisible = localStorage.getItem('userListVisible') !== 'false'
        if (!userListVisible) {
            userList.style.display = 'none'
            const icon = userListToggle.querySelector('i')
            icon.classList.remove('mdi-eye')
            icon.classList.add('mdi-eye-off')
        }

        userListToggle.addEventListener('click', () => {
            const isVisible = userList.style.display !== 'none'
            userList.style.display = isVisible ? 'none' : 'block'

            // Update icon
            const icon = userListToggle.querySelector('i')
            if (isVisible) {
                icon.classList.remove('mdi-eye')
                icon.classList.add('mdi-eye-off')
            } else {
                icon.classList.remove('mdi-eye-off')
                icon.classList.add('mdi-eye')
            }

            // Save state
            localStorage.setItem('userListVisible', !isVisible)
        })
    }
}

function init() {
    setRepeaterList()
    setupTabs()
    setupSettingsDropdown()
    setupNavbarBurger()
    setupVisibilityToggles()
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init)
} else {
	init()
}
