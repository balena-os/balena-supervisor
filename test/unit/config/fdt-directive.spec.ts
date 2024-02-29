import { expect } from 'chai';
import { FDTDirective } from '~/src/config/backends/extlinux-file';

describe('FDT directive', () => {
	const directive = new FDTDirective();

	it('parses valid FDT value', () => {
		VALID_VALUES.forEach(({ input, output }) =>
			// @ts-expect-error input with no FDT can still be parsed
			expect(directive.parse(input)).to.deep.equal(output),
		);
	});

	it('generates value from valid ConfigOptions', () => {
		expect(
			directive.generate({
				fdt: '/boot/mycustomdtb.dtb',
			}),
		).to.deep.equal('/boot/mycustomdtb.dtb');
	});

	it('errors when generating with invalid ConfigOptions', () => {
		INVALID_CONFIGS_OPTIONS.forEach(({ input, reason }) =>
			expect(() => directive.generate(input as any)).to.throw(reason),
		);
	});
});

const VALID_VALUES = [
	{
		input: {
			FDT: '/boot/mycustomdtb.dtb',
		},
		output: {
			fdt: '/boot/mycustomdtb.dtb',
		},
	},
	{
		input: {
			FDT: '',
		},
		output: {},
	},
	{
		input: {},
		output: {},
	},
];

const INVALID_CONFIGS_OPTIONS = [
	{
		input: {
			fdt: '',
		},
		reason: 'Cannot set FDT of an empty value.',
	},
	{
		input: {
			fdt: null,
		},
		reason: 'Cannot set FDT of non-string value: null',
	},
	{
		input: {},
		reason: 'Cannot set FDT of non-string value: ',
	},
];
