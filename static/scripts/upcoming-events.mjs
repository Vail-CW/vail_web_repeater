/**
 * Upcoming Events Widget for Vail Index Page
 * Displays events for the next 7 days
 */

/**
 * Fetch all events from the API
 */
async function fetchEvents() {
	try {
		const response = await fetch('/api/events');
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		const events = await response.json();
		return events || [];
	} catch (error) {
		console.error('Error fetching events:', error);
		return [];
	}
}

/**
 * Format date for display
 */
function formatDate(dateStr) {
	const date = new Date(dateStr + 'T00:00:00');
	return date.toLocaleDateString('en-US', {
		weekday: 'short',
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
 * Get all occurrences of an event within a date range
 */
function getEventOccurrencesInRange(event, startDate, endDate) {
	const occurrences = [];
	const eventDate = new Date(event.date + 'T00:00:00');

	if (event.recurring.type === 'once') {
		// Single occurrence
		if (eventDate >= startDate && eventDate <= endDate) {
			occurrences.push({ date: eventDate, event });
		}
	} else if (event.recurring.type === 'daily') {
		// Daily recurring
		let currentDate = new Date(Math.max(eventDate, startDate));
		while (currentDate <= endDate) {
			if (!event.recurring.endDate || currentDate <= new Date(event.recurring.endDate + 'T00:00:00')) {
				occurrences.push({ date: new Date(currentDate), event });
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
					occurrences.push({ date: new Date(currentDate), event });
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
					occurrences.push({ date: new Date(currentDate), event });
				}
			}
			currentDate.setMonth(currentDate.getMonth() + 1);
		}
	}

	return occurrences;
}

/**
 * Get upcoming events for the next 7 days
 */
function getUpcomingEvents(allEvents) {
	const now = new Date();
	now.setHours(0, 0, 0, 0);

	const sevenDaysFromNow = new Date(now);
	sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

	const upcomingOccurrences = [];

	allEvents.forEach(event => {
		const occurrences = getEventOccurrencesInRange(event, now, sevenDaysFromNow);
		upcomingOccurrences.push(...occurrences);
	});

	// Sort by date and time
	upcomingOccurrences.sort((a, b) => {
		const dateCompare = a.date.getTime() - b.date.getTime();
		if (dateCompare !== 0) return dateCompare;
		return a.event.time.localeCompare(b.event.time);
	});

	return upcomingOccurrences;
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
 * Show event details in modal
 */
function showEventDetails(eventId, allEvents) {
	const event = allEvents.find(e => e.id === eventId);
	if (!event) return;

	const modal = document.getElementById('event-details-modal-main');
	const content = document.getElementById('event-details-content-main');

	let recurrence = '';
	switch (event.recurring.type) {
		case 'daily':
			recurrence = 'Daily';
			break;
		case 'weekly':
			const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
			recurrence = `Every ${days[event.recurring.weekday]}`;
			break;
		case 'monthly':
			recurrence = 'Monthly';
			break;
	}

	content.innerHTML = `
		<div style="margin-bottom: 1rem;">
			<h3 style="font-size: 1.5rem; font-weight: 600; color: #00d1b2; margin-bottom: 1rem;">
				${escapeHtml(event.name)}
			</h3>
			<div style="display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1rem;">
				<div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; color: #e8e8e8;">
					<i class="mdi mdi-calendar"></i>
					<span>${formatDate(event.date)}</span>
				</div>
				<div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; color: #e8e8e8;">
					<i class="mdi mdi-clock"></i>
					<span>${formatTimeWithLocal(event.date, event.time, event.timezone)}</span>
				</div>
				<div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; color: #e8e8e8;">
					<i class="mdi mdi-door-open"></i>
					<span>${escapeHtml(event.room)}</span>
				</div>
				<div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; color: #e8e8e8;">
					<i class="mdi mdi-account"></i>
					<span>Created by ${escapeHtml(event.creator)}</span>
				</div>
				${event.email ? `
				<div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; color: #e8e8e8;">
					<i class="mdi mdi-email"></i>
					<span><a href="mailto:${escapeHtml(event.email)}" style="color: #0af;">${escapeHtml(event.email)}</a></span>
				</div>
				` : ''}
			</div>
			${recurrence ? `<div style="margin-bottom: 1rem;"><span style="display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.75rem; background: rgba(0, 134, 102, 0.2); border-radius: 12px; font-size: 0.8rem; color: #0af; font-weight: 600;"><i class="mdi mdi-refresh"></i> ${recurrence}</span></div>` : ''}
			${event.description ? `<div style="color: #e8e8e8; margin-bottom: 1rem; line-height: 1.6;">${escapeHtml(event.description)}</div>` : ''}
			<div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
				<a href="index.html#${encodeURIComponent(event.room)}" class="button is-info">
					<span class="icon"><i class="mdi mdi-login"></i></span>
					<span>Join Room</span>
				</a>
				<a href="events.html" class="button is-link is-light">
					<span class="icon"><i class="mdi mdi-calendar-clock"></i></span>
					<span>View All Events</span>
				</a>
			</div>
		</div>
	`;

	modal.classList.add('is-active');
}

/**
 * Render upcoming events list
 */
async function renderUpcomingEvents() {
	const listElement = document.getElementById('upcoming-events-list');
	if (!listElement) return;

	const allEvents = await fetchEvents();
	const upcomingEvents = getUpcomingEvents(allEvents);

	if (upcomingEvents.length === 0) {
		listElement.innerHTML = '<p class="has-text-grey-light is-size-7">No upcoming events in the next 7 days</p>';
		return;
	}

	let html = '';
	upcomingEvents.slice(0, 5).forEach(({ date, event }) => {
		const dateStr = date.toISOString().split('T')[0];
		const isRecurring = event.recurring.type !== 'once';

		html += `
			<div class="upcoming-event-item" onclick="window.showUpcomingEventDetails('${event.id}')">
				<div class="upcoming-event-date">
					<div class="upcoming-event-day">${date.getDate()}</div>
					<div class="upcoming-event-month">${date.toLocaleDateString('en-US', { month: 'short' })}</div>
				</div>
				<div class="upcoming-event-info">
					<div class="upcoming-event-name">${escapeHtml(event.name)}${isRecurring ? ' <i class="mdi mdi-refresh is-size-7"></i>' : ''}</div>
					<div class="upcoming-event-time">${formatTimeWithLocal(dateStr, event.time, event.timezone)}</div>
					<div class="upcoming-event-room"><i class="mdi mdi-door-open"></i> ${escapeHtml(event.room)}</div>
				</div>
			</div>
		`;
	});

	listElement.innerHTML = html;

	// Store all events for the modal
	window.allEventsData = allEvents;
}

/**
 * Initialize upcoming events widget
 */
function init() {
	// Render upcoming events
	renderUpcomingEvents();

	// Set up modal close button
	const closeBtn = document.getElementById('close-event-details-modal-btn');
	if (closeBtn) {
		closeBtn.addEventListener('click', () => {
			document.getElementById('event-details-modal-main').classList.remove('is-active');
		});
	}

	// Close modal on background click
	const modalBg = document.querySelector('#event-details-modal-main .modal-background');
	if (modalBg) {
		modalBg.addEventListener('click', () => {
			document.getElementById('event-details-modal-main').classList.remove('is-active');
		});
	}

	// Make showEventDetails available globally
	window.showUpcomingEventDetails = (eventId) => {
		showEventDetails(eventId, window.allEventsData || []);
	};
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
