/**
 * Enigma cipher engine for the Vail Weekly Enigma admin validator.
 *
 * This is a verbatim port of the engine used by shadowenigma.com
 * (src/lib/enigma/cryptiiEnigma.ts + enigmaService.ts), which is itself a
 * standalone adaptation of cryptii.com's Enigma encoder (MIT licensed,
 * https://github.com/cryptii/cryptii). Keeping the exact same engine here
 * guarantees that what an admin produces on shadowenigma.com decodes
 * identically when we validate it.
 *
 * Enigma is a symmetric cipher: decoding is the same operation as encoding.
 */

const alphabet = 'abcdefghijklmnopqrstuvwxyz'

/**
 * Rotor specifications.
 * Format: [name, label, wiring, turnovers]
 */
const rotorSpecs = [
	// Entry rotor
	['ETW-ABCDEF', 'Alphabet', 'abcdefghijklmnopqrstuvwxyz', ''],

	// Enigma I, M3, M4 rotors
	['I', 'I', 'ekmflgdqvzntowyhxuspaibrcj', 'q'],
	['II', 'II', 'ajdksiruxblhwtmcqgznpyfvoe', 'e'],
	['III', 'III', 'bdfhjlcprtxvznyeiwgakmusqo', 'v'],
	['IV', 'IV', 'esovpzjayquirhxlnftgkdcmwb', 'j'],
	['V', 'V', 'vzbrgityupsdnhlxawmjqofeck', 'z'],
	['VI', 'VI', 'jpgvoumfyqbenhzrdkasxlictw', 'zm'],
	['VII', 'VII', 'nzjhgrcxmyswboufaivlpekqdt', 'zm'],
	['VIII', 'VIII', 'fkqhtlxocbjspdzramewniuygv', 'zm'],

	// M4 thin rotors
	['beta', 'Beta', 'leyjvcnixwpbqmdrtakzgfuhos', ''],
	['gamma', 'Gamma', 'fsokanuerhmbtiycwlqpzxvgjd', ''],

	// Reflectors
	['UKW-A', 'UKW A', 'ejmzalyxvbwfcrquontspikhgd', ''],
	['UKW-B', 'UKW B', 'yruhqsldpxngokmiebfzcwvjat', ''],
	['UKW-C', 'UKW C', 'fvpjiaoyedrzxwgctkuqsbnmhl', ''],
	['UKW-B-thin', 'UKW B thin', 'enkqauywjicopblmdxzvfthrgs', ''],
	['UKW-C-thin', 'UKW C thin', 'rdobjntkvehmlfcwzaxgyipsuq', ''],
]

const models = [
	{
		name: 'M3',
		label: 'Enigma M3',
		characterGroupSize: 5,
		plugboard: true,
		entryRotor: 'ETW-ABCDEF',
		reflectorRotors: ['UKW-B', 'UKW-C'],
		slots: [
			{ rotors: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] },
			{ rotors: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] },
			{ rotors: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] },
		],
	},
	{
		name: 'M4',
		label: 'Enigma M4 "Shark"',
		characterGroupSize: 4,
		plugboard: true,
		entryRotor: 'ETW-ABCDEF',
		reflectorRotors: ['UKW-B-thin', 'UKW-C-thin'],
		slots: [
			{ rotors: ['beta', 'gamma'], rotating: false },
			{ rotors: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] },
			{ rotors: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] },
			{ rotors: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] },
		],
	},
]

// Create rotor lookup
const rotorMap = new Map()
rotorSpecs.forEach(([name, label, wiring, turnovers]) => {
	rotorMap.set(name, { name, label, wiring, turnovers })
})

/**
 * Map a character through a rotor.
 */
function rotorMapChar(char, rotor, position, ring, inverted) {
	const wiring = rotor.wiring
	const wiringLength = wiring.length

	// Apply position and ring offset
	char = (char + position - ring + wiringLength) % wiringLength

	if (!inverted) {
		// Forward through rotor
		char = wiring.charCodeAt(char) - 97
	} else {
		// Backward through rotor (inverted)
		char = wiring.indexOf(String.fromCharCode(char + 97))
	}

	// Remove position and ring offset
	char = (char - position + ring + wiringLength) % wiringLength

	return char
}

/**
 * Check if rotor is at turnover position.
 */
function rotorAtTurnover(rotor, position) {
	if (!rotor.turnovers || rotor.turnovers.length === 0) {
		return false
	}
	const letter = String.fromCharCode((position % 26) + 97)
	return rotor.turnovers.includes(letter)
}

/**
 * Create plugboard wiring from pairs.
 */
function createPlugboard(pairs) {
	let plugboard = alphabet

	pairs.forEach(pair => {
		if (pair.length !== 2) return

		const a = pair[0].toLowerCase()
		const b = pair[1].toLowerCase()
		const aIndex = alphabet.indexOf(a)
		const bIndex = alphabet.indexOf(b)

		if (aIndex === -1 || bIndex === -1) return

		// Swap letters in plugboard
		plugboard = plugboard.split('').map((char, index) => {
			if (index === aIndex) return b
			if (index === bIndex) return a
			return char
		}).join('')
	})

	return plugboard
}

/**
 * Encode (or, identically, decode) a string using the Enigma cipher.
 *
 * config: {
 *   model: 'M3' | 'M4',
 *   rotors: string[],         // Rotor types, left to right
 *   positions: number[],      // Initial positions 0-25, left to right
 *   rings: number[],          // Ring settings 0-25, left to right
 *   reflector: string,        // e.g. 'UKW-B'
 *   plugboardPairs: string[], // e.g. ['AB', 'CD']
 * }
 */
export function cryptiiEnigmaEncode(text, config) {
	const model = models.find(m => m.name === config.model)
	if (!model) {
		throw new Error(`Unknown model: ${config.model}`)
	}

	// Get rotors
	const slots = model.slots
	const slotCount = slots.length
	const slotRotating = slots.map(slot => slot.rotating !== false)
	const rotors = []
	const positions = [...config.positions]
	const rings = [...config.rings]

	for (let i = 0; i < slotCount; i++) {
		const rotorName = config.rotors[i]
		const rotor = rotorMap.get(rotorName)
		if (!rotor) {
			throw new Error(`Unknown rotor: ${rotorName}`)
		}
		rotors.push(rotor)
	}

	// Get entry and reflector
	const entryRotor = rotorMap.get(model.entryRotor)
	const reflectorRotor = rotorMap.get(config.reflector)
	if (!reflectorRotor) {
		throw new Error(`Unknown reflector: ${config.reflector}`)
	}

	// Create plugboard
	const plugboard = model.plugboard ? createPlugboard(config.plugboardPairs) : null

	// Encode each character
	const result = []
	const stepRotors = new Array(slotCount)

	for (let charIndex = 0; charIndex < text.length; charIndex++) {
		const inputChar = text[charIndex].toLowerCase()
		const codePoint = inputChar.charCodeAt(0)

		// Only process A-Z
		if (codePoint < 97 || codePoint > 122) {
			continue
		}

		let char = codePoint - 97

		// Step rotors BEFORE encoding (this is critical for Enigma!)
		stepRotors.fill(false)

		// Wheel-turnover mechanism
		for (let i = 0; i < slotCount; i++) {
			if (
				slotRotating[i] &&
				slotRotating[i - 1] &&
				rotorAtTurnover(rotors[i], positions[i])
			) {
				// Step this rotor
				stepRotors[i] = true

				// Step left hand rotor (double-stepping)
				if (i > 0) {
					stepRotors[i - 1] = true
				}
			}
		}

		// The rightmost rotor always steps
		stepRotors[slotCount - 1] = slotRotating[slotCount - 1]

		// Apply stepping
		for (let i = 0; i < slotCount; i++) {
			if (stepRotors[i]) {
				positions[i] = (positions[i] + 1) % 26
			}
		}

		// Through the plugboard
		if (plugboard !== null) {
			char = rotorMapChar(char, { name: 'plugboard', label: '', wiring: plugboard, turnovers: '' }, 0, 0, false)
		}

		// Through the entry rotor
		char = rotorMapChar(char, entryRotor, 0, 0, false)

		// Through the rotors (right to left)
		for (let i = rotors.length - 1; i >= 0; i--) {
			char = rotorMapChar(char, rotors[i], positions[i], rings[i], false)
		}

		// Through the reflector
		char = rotorMapChar(char, reflectorRotor, 0, 0, false)

		// Through the inverted rotors (left to right)
		for (let i = 0; i < rotors.length; i++) {
			char = rotorMapChar(char, rotors[i], positions[i], rings[i], true)
		}

		// Through the inverted entry
		char = rotorMapChar(char, entryRotor, 0, 0, true)

		// Through the inverted plugboard
		if (plugboard !== null) {
			char = rotorMapChar(char, { name: 'plugboard', label: '', wiring: plugboard, turnovers: '' }, 0, 0, true)
		}

		// Convert back to character
		result.push(String.fromCharCode(char + 97))
	}

	return result.join('').toUpperCase()
}

// --- Mapping helpers between the Vail admin form format and the engine -----

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function letterToNumber(letter) {
	return letter.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0)
}

function mapReflectorToCryptii(reflector) {
	const mapping = {
		A: 'UKW-A',
		B: 'UKW-B',
		C: 'UKW-C',
		BThin: 'UKW-B-thin',
		CThin: 'UKW-C-thin',
	}
	return mapping[reflector] || reflector
}

function mapRotorToCryptii(rotor) {
	if (rotor === 'Beta') return 'beta'
	if (rotor === 'Gamma') return 'gamma'
	return rotor
}

/**
 * Parse a plugboard string like "AB CD EF" into ['AB', 'CD', 'EF'].
 */
export function parsePlugboard(plugboard) {
	if (!plugboard) return []
	return plugboard
		.toUpperCase()
		.split(/[\s,]+/)
		.map(p => p.trim())
		.filter(p => p.length > 0)
}

/**
 * Validate a plugboard configuration (ported from shadowenigma).
 * Returns true if valid, or an error message string if invalid.
 */
export function validatePlugboard(pairs) {
	const usedLetters = new Set()

	for (const pair of pairs) {
		if (pair.length !== 2) {
			return `Invalid plugboard pair "${pair}": each pair must be exactly 2 letters.`
		}

		const [a, b] = pair.toUpperCase().split('')

		if (!/^[A-Z]$/.test(a) || !/^[A-Z]$/.test(b)) {
			return `Invalid plugboard pair "${pair}": only letters A-Z are allowed.`
		}

		if (a === b) {
			return `Invalid plugboard pair "${pair}": a letter cannot be paired with itself.`
		}

		if (usedLetters.has(a)) {
			return `Plugboard letter ${a} is used in more than one pair.`
		}
		if (usedLetters.has(b)) {
			return `Plugboard letter ${b} is used in more than one pair.`
		}

		usedLetters.add(a)
		usedLetters.add(b)
	}

	if (pairs.length > 13) {
		return 'Maximum 13 plugboard pairs allowed.'
	}

	return true
}

/**
 * Decode a ciphertext using the Vail admin form's settings format:
 *   {
 *     rotors: ['III','II','I'],        // Left, Middle, Right
 *     rotorPositions: ['A','A','A'],   // Left, Middle, Right (single letters)
 *     ringSettings: ['1','1','1'],     // Left, Middle, Right (1-26)
 *     reflector: 'B',
 *     plugboard: 'AB CD EF',
 *   }
 *
 * Returns the raw decoded text (letters only, uppercase). Because Enigma is
 * symmetric this is exactly what a solver gets by running the ciphertext
 * through the same settings on shadowenigma.com.
 */
export function decodeWithVailSettings(ciphertext, settings) {
	const config = {
		model: 'M3',
		rotors: (settings.rotors || []).map(mapRotorToCryptii),
		positions: (settings.rotorPositions || []).map(letterToNumber),
		rings: (settings.ringSettings || []).map(r => parseInt(r, 10) - 1),
		reflector: mapReflectorToCryptii(settings.reflector),
		plugboardPairs: parsePlugboard(settings.plugboard),
	}
	return cryptiiEnigmaEncode(ciphertext, config)
}

export { ALPHABET }
