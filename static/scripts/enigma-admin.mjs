/**
 * Vail Enigma Admin Module
 * Manages the Weekly Enigma puzzle for admins
 */

// Admin callsigns loaded from server
let adminCallsigns = [];

let adminPassword = null;
let currentPuzzle = null;

/**
 * Load admin callsigns from server
 */
async function loadAdminCallsigns() {
	try {
		const response = await fetch('/api/admin-callsigns');
		if (response.ok) {
			adminCallsigns = await response.json();
		}
	} catch (e) {
		console.error('Error loading admin callsigns:', e);
	}
}

/**
 * Get current user's callsign from localStorage
 */
function getCallsign() {
	return localStorage.getItem('callsign') || '';
}

/**
 * Get admin password from session storage
 */
function getAdminPassword() {
	if (!adminPassword) {
		adminPassword = sessionStorage.getItem('enigma_admin_password') || '';
	}
	return adminPassword;
}

/**
 * Set admin password in session storage
 */
function setAdminPassword(password) {
	adminPassword = password;
	sessionStorage.setItem('enigma_admin_password', password);
}

/**
 * Check if current user is admin
 */
function isAdmin() {
	const callsign = getCallsign().toUpperCase();
	return adminCallsigns.some(admin => admin.toUpperCase() === callsign);
}

/**
 * Load the current puzzle from the server
 */
async function loadCurrentPuzzle() {
	try {
		const password = getAdminPassword();
		const callsign = getCallsign();

		const headers = {
			'X-Callsign': callsign
		};
		if (password) {
			headers['X-Admin-Password'] = password;
		}

		const response = await fetch('/api/enigma/full', { headers });

		if (response.status === 401 || response.status === 403) {
			// Need to authenticate
			return { needsAuth: true };
		}

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const data = await response.json();
		if (data.error) {
			return null;
		}
		return data;
	} catch (e) {
		console.error('Error loading puzzle:', e);
		return null;
	}
}

/**
 * Save the puzzle to the server
 */
async function savePuzzle(puzzle) {
	try {
		const password = getAdminPassword();
		const callsign = getCallsign();

		if (!password) {
			return { needsAuth: true };
		}

		const response = await fetch('/api/enigma/update', {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				'X-Callsign': callsign,
				'X-Admin-Password': password
			},
			body: JSON.stringify(puzzle)
		});

		if (response.status === 401) {
			return { needsAuth: true };
		}

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(errorText || `HTTP error! status: ${response.status}`);
		}

		return await response.json();
	} catch (e) {
		console.error('Error saving puzzle:', e);
		throw e;
	}
}

/**
 * Display the current puzzle information
 */
function displayCurrentPuzzle(puzzle) {
	const container = document.getElementById('current-puzzle-content');
	if (!container) return;

	if (!puzzle || !puzzle.encodedMessage) {
		container.innerHTML = '<p class="has-text-grey-light">No puzzle currently set.</p>';
		return;
	}

	const settings = puzzle.settings || {};
	container.innerHTML = `
		<div class="columns is-multiline">
			<div class="column is-half">
				<p class="has-text-grey-light is-size-7">Rotors</p>
				<p class="has-text-light">${(settings.rotors || []).join(' - ') || '--'}</p>
			</div>
			<div class="column is-half">
				<p class="has-text-grey-light is-size-7">Start Positions</p>
				<p class="has-text-light">${(settings.rotorPositions || []).join(' - ') || '--'}</p>
			</div>
			<div class="column is-half">
				<p class="has-text-grey-light is-size-7">Ring Settings</p>
				<p class="has-text-light">${(settings.ringSettings || []).join(' - ') || '--'}</p>
			</div>
			<div class="column is-half">
				<p class="has-text-grey-light is-size-7">Reflector</p>
				<p class="has-text-light">${settings.reflector || '--'}</p>
			</div>
			<div class="column is-full">
				<p class="has-text-grey-light is-size-7">Plugboard</p>
				<p class="has-text-light" style="font-family: monospace;">${settings.plugboard || 'None'}</p>
			</div>
			<div class="column is-full">
				<p class="has-text-grey-light is-size-7">Encoded Message</p>
				<div class="message-preview">${escapeHtml(puzzle.encodedMessage)}</div>
			</div>
			<div class="column is-full">
				<p class="has-text-grey-light is-size-7">Decoded Message (Answer)</p>
				<div class="message-preview">${escapeHtml(puzzle.decodedMessage || '[Hidden]')}</div>
			</div>
			<div class="column is-full">
				<p class="has-text-grey-light is-size-7">Last Updated</p>
				<p class="has-text-light">${puzzle.updatedAt ? new Date(puzzle.updatedAt).toLocaleString() : '--'} by ${puzzle.createdBy || '--'}</p>
			</div>
		</div>
	`;
}

/**
 * Populate the form with current puzzle data
 */
function populateForm(puzzle) {
	if (!puzzle) return;

	const settings = puzzle.settings || {};

	// Rotors
	if (settings.rotors && settings.rotors.length >= 3) {
		document.getElementById('rotor-left').value = settings.rotors[0] || 'III';
		document.getElementById('rotor-middle').value = settings.rotors[1] || 'II';
		document.getElementById('rotor-right').value = settings.rotors[2] || 'I';
	}

	// Positions
	if (settings.rotorPositions && settings.rotorPositions.length >= 3) {
		document.getElementById('position-left').value = settings.rotorPositions[0] || 'A';
		document.getElementById('position-middle').value = settings.rotorPositions[1] || 'A';
		document.getElementById('position-right').value = settings.rotorPositions[2] || 'A';
	}

	// Ring Settings
	if (settings.ringSettings && settings.ringSettings.length >= 3) {
		document.getElementById('ring-left').value = settings.ringSettings[0] || '1';
		document.getElementById('ring-middle').value = settings.ringSettings[1] || '1';
		document.getElementById('ring-right').value = settings.ringSettings[2] || '1';
	}

	// Reflector
	if (settings.reflector) {
		document.getElementById('reflector').value = settings.reflector;
	}

	// Plugboard
	if (settings.plugboard) {
		document.getElementById('plugboard').value = settings.plugboard;
	}

	// Messages
	if (puzzle.encodedMessage) {
		document.getElementById('encoded-message').value = puzzle.encodedMessage;
	}
	if (puzzle.decodedMessage) {
		document.getElementById('decoded-message').value = puzzle.decodedMessage;
	}
}

/**
 * Get form data as puzzle object
 */
function getFormData() {
	// Get the selected save mode
	const saveMode = document.querySelector('input[name="save-mode"]:checked')?.value || 'update';

	return {
		settings: {
			rotors: [
				document.getElementById('rotor-left').value,
				document.getElementById('rotor-middle').value,
				document.getElementById('rotor-right').value
			],
			rotorPositions: [
				document.getElementById('position-left').value.toUpperCase(),
				document.getElementById('position-middle').value.toUpperCase(),
				document.getElementById('position-right').value.toUpperCase()
			],
			ringSettings: [
				document.getElementById('ring-left').value,
				document.getElementById('ring-middle').value,
				document.getElementById('ring-right').value
			],
			reflector: document.getElementById('reflector').value,
			plugboard: document.getElementById('plugboard').value.toUpperCase().trim()
		},
		encodedMessage: document.getElementById('encoded-message').value.toUpperCase().trim(),
		decodedMessage: document.getElementById('decoded-message').value.toUpperCase().trim(),
		createNew: saveMode === 'new'
	};
}

/**
 * Validate form data
 */
function validateForm(puzzle) {
	if (!puzzle.encodedMessage) {
		alert('Please enter an encoded message.');
		return false;
	}
	if (!puzzle.decodedMessage) {
		alert('Please enter a decoded message (the answer).');
		return false;
	}

	// Validate positions are single letters
	for (const pos of puzzle.settings.rotorPositions) {
		if (!/^[A-Z]$/.test(pos)) {
			alert('Start positions must be single letters A-Z.');
			return false;
		}
	}

	// Validate ring settings are numbers 1-26
	for (const ring of puzzle.settings.ringSettings) {
		const num = parseInt(ring);
		if (isNaN(num) || num < 1 || num > 26) {
			alert('Ring settings must be numbers 1-26.');
			return false;
		}
	}

	return true;
}

/**
 * Show admin password modal
 */
function showPasswordModal() {
	const modal = document.getElementById('admin-password-modal');
	const input = document.getElementById('admin-password-input');
	const error = document.getElementById('password-error');

	input.value = '';
	error.style.display = 'none';
	modal.classList.add('is-active');

	setTimeout(() => input.focus(), 100);
}

/**
 * Hide admin password modal
 */
function hidePasswordModal() {
	document.getElementById('admin-password-modal').classList.remove('is-active');
}

/**
 * Show success toast
 */
function showSuccessToast(isNewPuzzle = false) {
	const toast = document.getElementById('success-toast');
	const message = document.getElementById('success-toast-message');

	if (isNewPuzzle) {
		message.innerHTML = '<strong>Success!</strong> New puzzle created. All users can now solve this week\'s puzzle.';
	} else {
		message.innerHTML = '<strong>Success!</strong> The puzzle has been updated.';
	}

	toast.style.display = 'block';
	setTimeout(() => {
		toast.style.display = 'none';
	}, 4000);
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

/**
 * Handle form submission
 */
async function handleFormSubmit(e) {
	e.preventDefault();

	const puzzle = getFormData();
	if (!validateForm(puzzle)) {
		return;
	}

	const isNewPuzzle = puzzle.createNew;

	try {
		const result = await savePuzzle(puzzle);

		if (result && result.needsAuth) {
			showPasswordModal();
			return;
		}

		if (result && result.success) {
			showSuccessToast(isNewPuzzle);

			// Reset to "update" mode after saving a new puzzle
			if (isNewPuzzle) {
				document.querySelector('input[name="save-mode"][value="update"]').checked = true;
			}

			// Reload current puzzle display
			const updatedPuzzle = await loadCurrentPuzzle();
			if (updatedPuzzle && !updatedPuzzle.needsAuth) {
				currentPuzzle = updatedPuzzle;
				displayCurrentPuzzle(updatedPuzzle);
			}
		}
	} catch (e) {
		alert('Error saving puzzle: ' + e.message);
	}
}

/**
 * Handle password submission
 */
async function handlePasswordSubmit() {
	const password = document.getElementById('admin-password-input').value;
	const error = document.getElementById('password-error');

	if (!password) {
		error.style.display = 'block';
		return;
	}

	setAdminPassword(password);
	hidePasswordModal();

	// Retry loading/saving
	const puzzle = await loadCurrentPuzzle();
	if (puzzle && puzzle.needsAuth) {
		error.style.display = 'block';
		showPasswordModal();
		return;
	}

	if (puzzle) {
		currentPuzzle = puzzle;
		displayCurrentPuzzle(puzzle);
		populateForm(puzzle);
	}
}

/**
 * Initialize the page
 */
async function init() {
	// Load admin callsigns from server first
	await loadAdminCallsigns();

	// Check if user is admin
	if (!isAdmin()) {
		document.getElementById('not-admin-section').style.display = '';
		document.getElementById('admin-section').style.display = 'none';
		return;
	}

	// Show admin section
	document.getElementById('not-admin-section').style.display = 'none';
	document.getElementById('admin-section').style.display = '';

	// Set up form submission
	document.getElementById('enigma-form').addEventListener('submit', handleFormSubmit);

	// Set up password modal
	document.getElementById('close-password-modal-btn').addEventListener('click', hidePasswordModal);
	document.getElementById('cancel-password-btn').addEventListener('click', hidePasswordModal);
	document.getElementById('confirm-password-btn').addEventListener('click', handlePasswordSubmit);
	document.querySelector('#admin-password-modal .modal-background').addEventListener('click', hidePasswordModal);
	document.getElementById('admin-password-input').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			handlePasswordSubmit();
		}
	});

	// Set up toast close
	document.getElementById('close-toast-btn').addEventListener('click', () => {
		document.getElementById('success-toast').style.display = 'none';
	});

	// Force uppercase on position inputs
	['position-left', 'position-middle', 'position-right'].forEach(id => {
		const el = document.getElementById(id);
		el.addEventListener('input', () => {
			el.value = el.value.toUpperCase().replace(/[^A-Z]/g, '');
		});
	});

	// Force uppercase on plugboard
	document.getElementById('plugboard').addEventListener('input', (e) => {
		e.target.value = e.target.value.toUpperCase();
	});

	// Force uppercase on messages
	['encoded-message', 'decoded-message'].forEach(id => {
		const el = document.getElementById(id);
		el.addEventListener('input', () => {
			el.value = el.value.toUpperCase();
		});
	});

	// Hamburger menu toggle for mobile
	const burger = document.getElementById('navbar-burger');
	if (burger) {
		burger.addEventListener('click', () => {
			const target = document.getElementById('navbar-menu');
			burger.classList.toggle('is-active');
			target.classList.toggle('is-active');
		});
	}

	// Load current puzzle
	const puzzle = await loadCurrentPuzzle();
	if (puzzle && puzzle.needsAuth) {
		showPasswordModal();
		return;
	}

	if (puzzle) {
		currentPuzzle = puzzle;
		displayCurrentPuzzle(puzzle);
		populateForm(puzzle);
	} else {
		displayCurrentPuzzle(null);
	}
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
