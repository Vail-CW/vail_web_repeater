/**
 * Vail Events Module
 * Manages events stored on the server
 */

let editingEventId = null;
let deleteEventId = null;
let currentCallsign = null;
let adminPassword = null;
let pendingAdminAction = null; // Store pending admin action (edit or delete)

// Calendar state
let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();
let allEvents = []; // Cache all events

// Admin callsigns loaded from server
let adminCallsigns = [];

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
	if (!currentCallsign) {
		currentCallsign = localStorage.getItem('callsign') || '';
	}
	return currentCallsign;
}

/**
 * Get admin password from session storage
 */
function getAdminPassword() {
	if (!adminPassword) {
		adminPassword = sessionStorage.getItem('admin_password') || '';
	}
	return adminPassword;
}

/**
 * Set admin password in session storage
 */
function setAdminPassword(password) {
	adminPassword = password;
	sessionStorage.setItem('admin_password', password);
}

/**
 * Check if current user is admin
 */
function isAdmin() {
	const callsign = getCallsign().toUpperCase();
	return adminCallsigns.some(admin => admin.toUpperCase() === callsign);
}

/**
 * Check if current user is authenticated as admin
 */
function isAuthenticatedAdmin() {
	if (!isAdmin()) {
		return false;
	}
	// Check if admin is authenticated (has password stored)
	const authenticated = sessionStorage.getItem('admin_authenticated');
	const password = getAdminPassword();
	return authenticated === 'true' && password !== '';
}

/**
 * Get all events from the server
 */
async function getEvents() {
	try {
		const response = await fetch('/api/events');
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		const events = await response.json();
		return events || [];
	} catch (e) {
		console.error("Error loading events:", e);
		alert("Failed to load events from server.");
		return [];
	}
}

/**
 * Export events as JSON file
 */
async function exportEvents() {
	try {
		const response = await fetch('/api/events/export');
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const blob = await response.blob();
		const url = window.URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'events.json';
		document.body.appendChild(a);
		a.click();
		window.URL.revokeObjectURL(url);
		document.body.removeChild(a);

		console.log('Events exported successfully');
	} catch (e) {
		console.error("Error exporting events:", e);
		alert("Failed to export events: " + e.message);
	}
}

/**
 * Import events from JSON file (admin only)
 */
async function importEvents(file) {
	try {
		// Read file contents
		const fileText = await file.text();

		// Validate JSON
		let events;
		try {
			events = JSON.parse(fileText);
		} catch (e) {
			throw new Error("Invalid JSON file");
		}

		if (!Array.isArray(events)) {
			throw new Error("JSON file must contain an array of events");
		}

		// Confirm import
		const confirmed = confirm(`Import ${events.length} events? This will replace ALL existing events. This action cannot be undone.`);
		if (!confirmed) {
			return;
		}

		// Get admin credentials
		const callsign = getCallsign();
		const password = getAdminPassword();

		if (!isAdmin()) {
			alert("Only admins can import events");
			return;
		}

		if (!password) {
			alert("Please authenticate as admin first by editing an event");
			return;
		}

		// Send to server
		const response = await fetch('/api/events/import', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Callsign': callsign,
				'X-Admin-Password': password
			},
			body: fileText
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(errorText || `HTTP error! status: ${response.status}`);
		}

		const result = await response.json();
		alert(`Successfully imported ${result.count} events!`);

		// Reload calendar
		await renderCalendar();

	} catch (e) {
		console.error("Error importing events:", e);
		alert("Failed to import events: " + e.message);
	}
}

/**
 * Create a new event on the server
 */
async function createEvent(event) {
	try {
		const response = await fetch('/api/events/create', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(event)
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(errorText || `HTTP error! status: ${response.status}`);
		}

		return await response.json();
	} catch (e) {
		console.error("Error creating event:", e);
		alert("Failed to create event: " + e.message);
		return null;
	}
}

/**
 * Update an event on the server
 */
async function updateEvent(eventId, event, adminPass = null) {
	try {
		const headers = {
			'Content-Type': 'application/json',
			'X-Callsign': getCallsign()
		};

		// Include admin password if provided or if stored
		const password = adminPass || getAdminPassword();
		if (password && isAdmin()) {
			headers['X-Admin-Password'] = password;
		}

		const response = await fetch(`/api/events/update?id=${encodeURIComponent(eventId)}`, {
			method: 'PUT',
			headers: headers,
			body: JSON.stringify(event)
		});

		if (!response.ok) {
			const errorText = await response.text();
			// Check if it's an admin password error
			if (response.status === 401 && errorText.includes('Admin password')) {
				return { needsAdminAuth: true };
			}
			throw new Error(errorText || `HTTP error! status: ${response.status}`);
		}

		return await response.json();
	} catch (e) {
		console.error("Error updating event:", e);
		alert("Failed to update event: " + e.message);
		return null;
	}
}

/**
 * Delete an event from the server
 */
async function deleteEventOnServer(eventId, adminPass = null) {
	try {
		const headers = {
			'X-Callsign': getCallsign()
		};

		// Include admin password if provided or if stored
		const password = adminPass || getAdminPassword();
		if (password && isAdmin()) {
			headers['X-Admin-Password'] = password;
		}

		const response = await fetch(`/api/events/delete?id=${encodeURIComponent(eventId)}`, {
			method: 'DELETE',
			headers: headers
		});

		if (!response.ok) {
			const errorText = await response.text();
			// Check if it's an admin password error
			if (response.status === 401 && errorText.includes('Admin password')) {
				return { needsAdminAuth: true };
			}
			throw new Error(errorText || `HTTP error! status: ${response.status}`);
		}

		return true;
	} catch (e) {
		console.error("Error deleting event:", e);
		alert("Failed to delete event: " + e.message);
		return false;
	}
}

/**
 * Generate a unique ID for an event
 */
function generateId() {
	return `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Format date for display
 */
function formatDate(dateStr) {
	const date = new Date(dateStr + 'T00:00:00');
	return date.toLocaleDateString('en-US', {
		weekday: 'short',
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});
}

/**
 * Format time for display
 */
function formatTime(timeStr) {
	const [hours, minutes] = timeStr.split(':');
	const hour = parseInt(hours);
	const ampm = hour >= 12 ? 'PM' : 'AM';
	const displayHour = hour % 12 || 12;
	return `${displayHour}:${minutes} ${ampm}`;
}

/**
 * Check if a date is in Daylight Saving Time for a given timezone
 */
function isDST(date, tzAbbr) {
	const tz = tzAbbr.toUpperCase();

	// Timezones that don't observe DST
	if (['UTC', 'GMT', 'HST', 'JST', 'AEST'].includes(tz)) {
		return false;
	}

	// For US timezones, DST is second Sunday in March to first Sunday in November
	const year = date.getFullYear();

	// Find second Sunday in March
	const marchFirst = new Date(year, 2, 1); // March is month 2
	const marchSecondSunday = new Date(year, 2, (14 - marchFirst.getDay()) % 7 + 8);
	marchSecondSunday.setHours(2, 0, 0, 0); // 2 AM

	// Find first Sunday in November
	const novemberFirst = new Date(year, 10, 1); // November is month 10
	const novemberFirstSunday = new Date(year, 10, (7 - novemberFirst.getDay()) % 7 + 1);
	novemberFirstSunday.setHours(2, 0, 0, 0); // 2 AM

	return date >= marchSecondSunday && date < novemberFirstSunday;
}

/**
 * Convert timezone abbreviation to UTC offset in hours, accounting for DST
 */
function getTimezoneOffset(tzAbbr, date) {
	const tz = tzAbbr.toUpperCase();
	const inDST = isDST(date, tz);

	const timezones = {
		'ET': inDST ? -4 : -5,
		'EST': -5,
		'EDT': -4,
		'CT': inDST ? -5 : -6,
		'CST': -6,
		'CDT': -5,
		'MT': inDST ? -6 : -7,
		'MST': -7,
		'MDT': -6,
		'PT': inDST ? -7 : -8,
		'PST': -8,
		'PDT': -7,
		'AKST': inDST ? -8 : -9,
		'AKDT': -8,
		'HST': -10,
		'HDT': -9,
		'UTC': 0,
		'GMT': 0,
		'BST': 1,
		'CET': 1,
		'CEST': 2,
		'JST': 9,
		'AEST': 10,
		'AEDT': 11
	};
	return timezones[tz] || 0;
}

/**
 * Format time with local timezone conversion
 */
function formatTimeWithLocal(dateStr, timeStr, timezone) {
	const [hours, minutes] = timeStr.split(':');

	// Create a date object in the event's timezone
	const date = new Date(dateStr + 'T' + timeStr + ':00');

	// Get the event timezone offset, accounting for DST on the event date
	const eventTzOffset = getTimezoneOffset(timezone, date);

	// Adjust for timezone offset difference
	const localOffset = -date.getTimezoneOffset() / 60; // Local timezone offset in hours
	const offsetDiff = localOffset - eventTzOffset;

	// Create local time by adjusting the hours
	const localDate = new Date(date);
	localDate.setHours(localDate.getHours() + offsetDiff);

	const formattedEventTime = formatTime(timeStr);
	const localHours = localDate.getHours();
	const localMinutes = localDate.getMinutes();
	const formattedLocalTime = formatTime(`${String(localHours).padStart(2, '0')}:${String(localMinutes).padStart(2, '0')}`);

	// Check if times are the same
	if (formattedEventTime === formattedLocalTime) {
		return `${formattedEventTime} ${timezone}`;
	}

	return `${formattedEventTime} ${timezone} <span style="color: #999;">(${formattedLocalTime} your time)</span>`;
}

/**
 * Get the next occurrence date for a recurring event
 */
function getNextOccurrence(event) {
	const today = new Date();
	today.setHours(0, 0, 0, 0);

	const eventDate = new Date(event.date + 'T00:00:00');
	const [hours, minutes] = event.time.split(':');

	// Check if event has passed today
	const todayWithTime = new Date();
	todayWithTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

	if (event.recurring.type === 'once') {
		return eventDate >= today ? eventDate : null;
	}

	let nextDate = new Date(today);

	if (event.recurring.type === 'daily') {
		// If time hasn't passed today, return today, otherwise tomorrow
		if (todayWithTime > new Date()) {
			nextDate.setDate(nextDate.getDate() + 1);
		}
	} else if (event.recurring.type === 'weekly') {
		const targetDay = event.recurring.weekday;
		const currentDay = nextDate.getDay();
		let daysUntil = targetDay - currentDay;

		// If target day is today, check if time has passed
		if (daysUntil === 0 && todayWithTime <= new Date()) {
			// Event is today and hasn't passed yet
			daysUntil = 0;
		} else if (daysUntil <= 0) {
			// Move to next week
			daysUntil += 7;
		}

		nextDate.setDate(nextDate.getDate() + daysUntil);
	} else if (event.recurring.type === 'monthly') {
		const targetDate = eventDate.getDate();
		nextDate.setDate(targetDate);

		// If date has passed this month, move to next month
		if (nextDate < today || (nextDate.getTime() === today.getTime() && todayWithTime > new Date())) {
			nextDate.setMonth(nextDate.getMonth() + 1);
		}
	}

	// Check if we're past the end date
	if (event.recurring.endDate) {
		const endDate = new Date(event.recurring.endDate + 'T23:59:59');
		if (nextDate > endDate) {
			return null;
		}
	}

	return nextDate;
}

/**
 * Get recurrence description
 */
function getRecurrenceDescription(event) {
	switch (event.recurring.type) {
		case 'daily':
			return 'Daily';
		case 'weekly':
			const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
			return `Every ${days[event.recurring.weekday]}`;
		case 'monthly':
			return 'Monthly';
		default:
			return null;
	}
}

/**
 * Check if current user can modify an event
 */
function canModifyEvent(event) {
	const callsign = getCallsign();
	// User can modify if they're the creator
	if (event.creator === callsign) {
		return true;
	}
	// Or if they're authenticated as admin
	return isAuthenticatedAdmin();
}

/**
 * Render calendar view
 */
async function renderCalendar() {
	const calendarGrid = document.getElementById('calendar-grid');
	const monthYearEl = document.getElementById('calendar-month-year');
	const emptyState = document.getElementById('empty-state');

	// Load all events
	allEvents = await getEvents();

	// Update month/year display
	const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
						'July', 'August', 'September', 'October', 'November', 'December'];
	monthYearEl.textContent = `${monthNames[currentMonth]} ${currentYear}`;

	// Generate calendar
	const firstDay = new Date(currentYear, currentMonth, 1);
	const lastDay = new Date(currentYear, currentMonth + 1, 0);
	const daysInMonth = lastDay.getDate();
	const startingDayOfWeek = firstDay.getDay();

	// Calculate events for this month and get all occurrences
	const monthEvents = getEventsForMonth(currentYear, currentMonth);

	// Create calendar grid HTML
	let calendarHTML = '';

	// Day headers
	const dayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	dayHeaders.forEach(day => {
		calendarHTML += `<div class="calendar-day-header">${day}</div>`;
	});

	// Previous month days
	const prevMonthLastDay = new Date(currentYear, currentMonth, 0).getDate();
	for (let i = startingDayOfWeek - 1; i >= 0; i--) {
		calendarHTML += `<div class="calendar-day other-month"><div class="calendar-day-number">${prevMonthLastDay - i}</div></div>`;
	}

	// Current month days
	const today = new Date();
	for (let day = 1; day <= daysInMonth; day++) {
		const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
		const isToday = today.getDate() === day && today.getMonth() === currentMonth && today.getFullYear() === currentYear;
		const dayEvents = monthEvents[dateStr] || [];

		calendarHTML += `
			<div class="calendar-day ${isToday ? 'today' : ''}">
				<div class="calendar-day-number">${day}</div>
				${dayEvents.map(event => `
					<div class="calendar-event ${event.recurring.type !== 'once' ? 'recurring' : ''}" onclick="showEventDetails('${event.id}')">
						<span class="calendar-event-time">${formatTime(event.time)}</span>
						<span class="calendar-event-name">${escapeHtml(event.name)}</span>
					</div>
				`).join('')}
			</div>
		`;
	}

	// Next month days to fill the grid
	const totalCells = startingDayOfWeek + daysInMonth;
	const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
	for (let day = 1; day <= remainingCells; day++) {
		calendarHTML += `<div class="calendar-day other-month"><div class="calendar-day-number">${day}</div></div>`;
	}

	calendarGrid.innerHTML = calendarHTML;

	// Show/hide empty state
	if (allEvents.length === 0) {
		emptyState.style.display = 'block';
	} else {
		emptyState.style.display = 'none';
	}
}

/**
 * Get all events for a specific month, including recurring event instances
 */
function getEventsForMonth(year, month) {
	const monthEvents = {};
	const firstDay = new Date(year, month, 1);
	const lastDay = new Date(year, month + 1, 0);

	allEvents.forEach(event => {
		// Get all occurrences of this event in this month
		const occurrences = getEventOccurrencesInRange(event, firstDay, lastDay);

		occurrences.forEach(dateStr => {
			if (!monthEvents[dateStr]) {
				monthEvents[dateStr] = [];
			}
			monthEvents[dateStr].push(event);
		});
	});

	// Sort events by time within each day
	Object.keys(monthEvents).forEach(dateStr => {
		monthEvents[dateStr].sort((a, b) => a.time.localeCompare(b.time));
	});

	return monthEvents;
}

/**
 * Get all occurrences of an event within a date range
 */
function getEventOccurrencesInRange(event, startDate, endDate) {
	const occurrences = [];
	const eventDate = new Date(event.date + 'T00:00:00');

	if (event.recurring.type === 'once') {
		// Single occurrence
		if (eventDate >= startDate && eventDate <= endDate) {
			occurrences.push(event.date);
		}
	} else if (event.recurring.type === 'daily') {
		// Daily recurring
		let currentDate = new Date(Math.max(eventDate, startDate));
		while (currentDate <= endDate) {
			const dateStr = currentDate.toISOString().split('T')[0];
			if (!event.recurring.endDate || currentDate <= new Date(event.recurring.endDate + 'T00:00:00')) {
				occurrences.push(dateStr);
			}
			currentDate.setDate(currentDate.getDate() + 1);
		}
	} else if (event.recurring.type === 'weekly') {
		// Weekly recurring
		const targetWeekday = event.recurring.weekday;
		let currentDate = new Date(startDate);

		// Find first occurrence of target weekday in range
		while (currentDate.getDay() !== targetWeekday && currentDate <= endDate) {
			currentDate.setDate(currentDate.getDate() + 1);
		}

		// Add all weekly occurrences
		while (currentDate <= endDate) {
			if (currentDate >= eventDate) {
				if (!event.recurring.endDate || currentDate <= new Date(event.recurring.endDate + 'T00:00:00')) {
					const dateStr = currentDate.toISOString().split('T')[0];
					occurrences.push(dateStr);
				}
			}
			currentDate.setDate(currentDate.getDate() + 7);
		}
	} else if (event.recurring.type === 'monthly') {
		// Monthly recurring
		const targetDay = eventDate.getDate();
		let currentDate = new Date(startDate.getFullYear(), startDate.getMonth(), targetDay);

		if (currentDate < startDate) {
			currentDate.setMonth(currentDate.getMonth() + 1);
		}

		while (currentDate <= endDate) {
			if (currentDate >= eventDate) {
				if (!event.recurring.endDate || currentDate <= new Date(event.recurring.endDate + 'T00:00:00')) {
					const dateStr = currentDate.toISOString().split('T')[0];
					occurrences.push(dateStr);
				}
			}
			currentDate.setMonth(currentDate.getMonth() + 1);
		}
	}

	return occurrences;
}

/**
 * Navigate to previous month
 */
function previousMonth() {
	currentMonth--;
	if (currentMonth < 0) {
		currentMonth = 11;
		currentYear--;
	}
	renderCalendar();
}

/**
 * Navigate to next month
 */
function nextMonth() {
	currentMonth++;
	if (currentMonth > 11) {
		currentMonth = 0;
		currentYear++;
	}
	renderCalendar();
}

/**
 * Navigate to current month
 */
function goToToday() {
	const today = new Date();
	currentMonth = today.getMonth();
	currentYear = today.getFullYear();
	renderCalendar();
}

/**
 * Show event details in modal
 */
window.showEventDetails = function(eventId) {
	const event = allEvents.find(e => e.id === eventId);
	if (!event) return;

	const modal = document.getElementById('event-details-modal');
	const content = document.getElementById('event-details-content');
	const recurrence = getRecurrenceDescription(event);

	content.innerHTML = `
		<div class="event-name">${escapeHtml(event.name)}</div>
		<div class="event-meta">
			<div class="event-meta-item">
				<i class="mdi mdi-calendar"></i>
				<span>${formatDate(event.date)}</span>
			</div>
			<div class="event-meta-item">
				<i class="mdi mdi-clock"></i>
				<span>${formatTimeWithLocal(event.date, event.time, event.timezone)}</span>
			</div>
			<div class="event-meta-item">
				<i class="mdi mdi-door-open"></i>
				<span>${escapeHtml(event.room)}</span>
			</div>
			<div class="event-meta-item">
				<i class="mdi mdi-account"></i>
				<span>Created by ${escapeHtml(event.creator)}</span>
			</div>
			${event.email ? `
			<div class="event-meta-item">
				<i class="mdi mdi-email"></i>
				<span><a href="mailto:${escapeHtml(event.email)}">${escapeHtml(event.email)}</a></span>
			</div>
			` : ''}
		</div>
		${recurrence ? `<div class="mb-3"><span class="recurring-badge"><i class="mdi mdi-refresh"></i> ${recurrence}</span></div>` : ''}
		${event.description ? `<div class="event-description">${escapeHtml(event.description)}</div>` : ''}
		<div class="event-actions">
			<button class="button is-info" onclick="joinRoom('${escapeHtml(event.room)}')">
				<span class="icon"><i class="mdi mdi-login"></i></span>
				<span>Join Room</span>
			</button>
			${canModifyEvent(event) ? `
			<button class="button is-warning" onclick="editEvent('${event.id}'); document.getElementById('event-details-modal').classList.remove('is-active');">
				<span class="icon"><i class="mdi mdi-pencil"></i></span>
				<span>Edit</span>
			</button>
			<button class="button is-danger" onclick="confirmDeleteEvent('${event.id}'); document.getElementById('event-details-modal').classList.remove('is-active');">
				<span class="icon"><i class="mdi mdi-delete"></i></span>
				<span>Delete</span>
			</button>
			` : ''}
		</div>
	`;

	modal.classList.add('is-active');
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
 * Join a room (redirect to main page with room hash)
 */
window.joinRoom = function(roomName) {
	window.location.href = `index.html#${encodeURIComponent(roomName)}`;
}

/**
 * Open modal to create a new event
 */
function openCreateEventModal() {
	editingEventId = null;
	document.getElementById('modal-title').textContent = 'Create Event';
	document.getElementById('event-id').value = '';
	document.getElementById('event-name').value = '';
	document.getElementById('event-room').value = '';
	document.getElementById('event-date').value = '';
	document.getElementById('event-time').value = '20:00';
	document.getElementById('event-timezone').value = 'ET';
	document.getElementById('event-description').value = '';
	document.getElementById('event-email').value = '';
	document.getElementById('event-recurrence').value = 'once';
	document.getElementById('event-weekday').value = '5';
	document.getElementById('event-has-end-date').checked = false;
	document.getElementById('event-end-date').value = '';

	updateRecurrenceFields();

	document.getElementById('event-modal').classList.add('is-active');
	document.getElementById('event-name').focus();
}

/**
 * Edit an existing event
 */
window.editEvent = async function(eventId) {
	const events = await getEvents();
	const event = events.find(e => e.id === eventId);

	if (!event) {
		alert('Event not found');
		return;
	}

	editingEventId = eventId;
	document.getElementById('modal-title').textContent = 'Edit Event';
	document.getElementById('event-id').value = event.id;
	document.getElementById('event-name').value = event.name;
	document.getElementById('event-room').value = event.room;
	document.getElementById('event-date').value = event.date;
	document.getElementById('event-time').value = event.time;
	document.getElementById('event-timezone').value = event.timezone;
	document.getElementById('event-description').value = event.description || '';
	document.getElementById('event-email').value = event.email || '';
	document.getElementById('event-recurrence').value = event.recurring.type;
	document.getElementById('event-weekday').value = event.recurring.weekday || '5';

	if (event.recurring.endDate) {
		document.getElementById('event-has-end-date').checked = true;
		document.getElementById('event-end-date').value = event.recurring.endDate;
	} else {
		document.getElementById('event-has-end-date').checked = false;
		document.getElementById('event-end-date').value = '';
	}

	updateRecurrenceFields();

	document.getElementById('event-modal').classList.add('is-active');
	document.getElementById('event-name').focus();
}

/**
 * Show/hide recurrence fields based on selection
 */
function updateRecurrenceFields() {
	const recurrence = document.getElementById('event-recurrence').value;
	const weekdayField = document.getElementById('weekday-field');
	const endDateField = document.getElementById('end-date-field');
	const endDateInputField = document.getElementById('end-date-input-field');
	const hasEndDate = document.getElementById('event-has-end-date').checked;

	if (recurrence === 'weekly') {
		weekdayField.style.display = 'block';
	} else {
		weekdayField.style.display = 'none';
	}

	if (recurrence !== 'once') {
		endDateField.style.display = 'block';
		if (hasEndDate) {
			endDateInputField.style.display = 'block';
		} else {
			endDateInputField.style.display = 'none';
		}
	} else {
		endDateField.style.display = 'none';
		endDateInputField.style.display = 'none';
	}
}

/**
 * Save event from modal
 */
async function saveEventFromModal(adminPass = null) {
	const name = document.getElementById('event-name').value.trim();
	const room = document.getElementById('event-room').value.trim();
	const date = document.getElementById('event-date').value;
	const time = document.getElementById('event-time').value;
	const timezone = document.getElementById('event-timezone').value;
	const description = document.getElementById('event-description').value.trim();
	const email = document.getElementById('event-email').value.trim();
	const recurrence = document.getElementById('event-recurrence').value;
	const weekday = parseInt(document.getElementById('event-weekday').value);
	const hasEndDate = document.getElementById('event-has-end-date').checked;
	const endDate = document.getElementById('event-end-date').value;

	// Validation
	if (!name) {
		alert('Please enter an event name');
		return;
	}
	if (!room) {
		alert('Please enter a room name');
		return;
	}
	if (!date) {
		alert('Please select a date');
		return;
	}
	if (!time) {
		alert('Please select a time');
		return;
	}

	const callsign = getCallsign();
	if (!callsign) {
		alert('Please set your callsign first by visiting the main page');
		return;
	}

	const event = {
		id: editingEventId || generateId(),
		name,
		room,
		date,
		time,
		timezone,
		description,
		email,
		creator: callsign,
		recurring: {
			type: recurrence,
			weekday: recurrence === 'weekly' ? weekday : null,
			endDate: (recurrence !== 'once' && hasEndDate) ? endDate : null
		}
	};

	let result;
	let success = false;

	if (editingEventId) {
		// Update existing event
		result = await updateEvent(editingEventId, event, adminPass);
		if (result && result.needsAdminAuth) {
			// Store the pending action and show admin password prompt
			pendingAdminAction = { type: 'edit', event: event };
			showAdminPasswordPrompt();
			return;
		}
		success = result !== null && !result.needsAdminAuth;
	} else {
		// Add new event
		result = await createEvent(event);
		success = result !== null;
	}

	if (success) {
		closeModal();
		await renderCalendar();
	}
}

/**
 * Confirm delete event
 */
window.confirmDeleteEvent = async function(eventId) {
	const events = await getEvents();
	const event = events.find(e => e.id === eventId);

	if (!event) {
		alert('Event not found');
		return;
	}

	deleteEventId = eventId;
	document.getElementById('delete-event-name').textContent = event.name;
	document.getElementById('delete-modal').classList.add('is-active');
}

/**
 * Delete event
 */
async function performDeleteEvent(adminPass = null) {
	if (!deleteEventId) return;

	const result = await deleteEventOnServer(deleteEventId, adminPass);

	if (result && result.needsAdminAuth) {
		// Store the pending action and show admin password prompt
		pendingAdminAction = { type: 'delete', eventId: deleteEventId };
		showAdminPasswordPrompt();
		return;
	}

	if (result === true) {
		closeDeleteModal();
		await renderCalendar();
		deleteEventId = null;
	}
}

/**
 * Close event modal
 */
function closeModal() {
	document.getElementById('event-modal').classList.remove('is-active');
	editingEventId = null;
}

/**
 * Close delete modal
 */
function closeDeleteModal() {
	document.getElementById('delete-modal').classList.remove('is-active');
	deleteEventId = null;
}

/**
 * Show admin password prompt
 */
function showAdminPasswordPrompt() {
	const modal = document.getElementById('admin-password-modal');
	const input = document.getElementById('admin-password-input');
	const error = document.getElementById('admin-password-error');

	input.value = '';
	error.style.display = 'none';
	modal.classList.add('is-active');

	setTimeout(() => input.focus(), 100);
}

/**
 * Close admin password modal
 */
function closeAdminPasswordModal() {
	document.getElementById('admin-password-modal').classList.remove('is-active');
	pendingAdminAction = null;
}

/**
 * Handle admin password submission
 */
async function handleAdminPasswordSubmit() {
	const password = document.getElementById('admin-password-input').value;
	const error = document.getElementById('admin-password-error');

	if (!password) {
		error.style.display = 'block';
		return;
	}

	if (!pendingAdminAction) {
		closeAdminPasswordModal();
		return;
	}

	// Store the password for this session
	setAdminPassword(password);

	// Retry the pending action
	if (pendingAdminAction.type === 'edit') {
		closeAdminPasswordModal();
		await saveEventFromModal(password);
	} else if (pendingAdminAction.type === 'delete') {
		closeAdminPasswordModal();
		await performDeleteEvent(password);
	}

	pendingAdminAction = null;
}

/**
 * Initialize the events page
 */
async function init() {
	// Load admin callsigns from server first
	await loadAdminCallsigns();

	// Show export/import buttons for admins
	if (isAdmin()) {
		document.getElementById('export-events-btn').style.display = 'inline-flex';
		document.getElementById('import-events-btn').style.display = 'inline-flex';
	}

	// Render calendar on page load
	await renderCalendar();

	// Create event button
	document.getElementById('create-event-btn').addEventListener('click', openCreateEventModal);

	// Export button
	document.getElementById('export-events-btn').addEventListener('click', exportEvents);

	// Import button
	document.getElementById('import-events-btn').addEventListener('click', () => {
		document.getElementById('import-file-input').click();
	});

	// Handle file selection for import
	document.getElementById('import-file-input').addEventListener('change', (e) => {
		const file = e.target.files[0];
		if (file) {
			importEvents(file);
			// Reset file input so the same file can be selected again
			e.target.value = '';
		}
	});

	// Month navigation buttons
	document.getElementById('prev-month-btn').addEventListener('click', previousMonth);
	document.getElementById('next-month-btn').addEventListener('click', nextMonth);
	document.getElementById('today-btn').addEventListener('click', goToToday);

	// Event details modal close button
	document.getElementById('close-event-details-btn').addEventListener('click', () => {
		document.getElementById('event-details-modal').classList.remove('is-active');
	});

	// Modal controls
	document.getElementById('close-modal-btn').addEventListener('click', closeModal);
	document.getElementById('cancel-modal-btn').addEventListener('click', closeModal);
	document.getElementById('save-event-btn').addEventListener('click', saveEventFromModal);
	document.querySelector('#event-modal .modal-background').addEventListener('click', closeModal);

	// Delete modal controls
	document.getElementById('close-delete-modal-btn').addEventListener('click', closeDeleteModal);
	document.getElementById('cancel-delete-modal-btn').addEventListener('click', closeDeleteModal);
	document.getElementById('confirm-delete-btn').addEventListener('click', performDeleteEvent);
	document.querySelector('#delete-modal .modal-background').addEventListener('click', closeDeleteModal);

	// Admin password modal controls
	document.getElementById('close-admin-modal-btn').addEventListener('click', closeAdminPasswordModal);
	document.getElementById('cancel-admin-modal-btn').addEventListener('click', closeAdminPasswordModal);
	document.getElementById('confirm-admin-password-btn').addEventListener('click', handleAdminPasswordSubmit);
	document.querySelector('#admin-password-modal .modal-background').addEventListener('click', closeAdminPasswordModal);

	// Handle form submission for admin password
	document.getElementById('admin-password-form').addEventListener('submit', (e) => {
		e.preventDefault();
		handleAdminPasswordSubmit();
	});

	// Allow Enter key to submit admin password
	document.getElementById('admin-password-input').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			handleAdminPasswordSubmit();
		}
	});

	// Recurrence field updates
	document.getElementById('event-recurrence').addEventListener('change', updateRecurrenceFields);
	document.getElementById('event-has-end-date').addEventListener('change', updateRecurrenceFields);

	// Set default date to today if creating new event
	const dateInput = document.getElementById('event-date');
	if (!dateInput.value) {
		const today = new Date().toISOString().split('T')[0];
		dateInput.value = today;
	}

	// Auto-select weekday based on selected date
	document.getElementById('event-date').addEventListener('change', (e) => {
		const date = new Date(e.target.value + 'T00:00:00');
		const weekday = date.getDay();
		document.getElementById('event-weekday').value = weekday;
	});

	// Hamburger menu toggle for mobile
	const burger = document.querySelector('.navbar-burger');
	if (burger) {
		burger.addEventListener('click', () => {
			const target = document.getElementById('navbar-menu');
			burger.classList.toggle('is-active');
			target.classList.toggle('is-active');
		});
	}
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
