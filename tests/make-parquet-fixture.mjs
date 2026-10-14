import fs from 'node:fs';
import {parquetWriteBuffer} from 'hyparquet-writer';

const bytes = parquetWriteBuffer({
    columnData: [
        {name: 'gene', data: ['TP53', 'MYC'], type: 'STRING'},
        {name: 'value', data: [1, 2], type: 'INT32'},
    ],
    codec: 'SNAPPY', rowGroupSize: 2, statistics: false,
});
fs.writeFileSync(process.argv[2], Buffer.from(bytes));
