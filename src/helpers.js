module.exports = [
    {
        type: 'helper',
        name: 'Line clamp',
        prefix: 'LineClamp',
        declaration: {
            '-webkit-line-clamp': '$0',
            'max-height': '$1'
        },
        rules: {
            '[class*=LineClamp]': {
               'display': '-webkit-box',
               '-webkit-box-orient': 'vertical',
               'overflow': 'hidden'
            },
            'a[class*=LineClamp]': {
               'display': 'inline-block',
               '*display': 'inline',
               'zoom': 1
            },
            /**
             * Fix WebKit bug that displays ellipsis in middle of text inside *LINKS*
             * see: https://twitter.com/thierrykoblentz/status/443899465842176000
             * 1. removes that hack out of the flow (bug reported by Fonda)
             */
            'a[class*=LineClamp]:after': {
               'content': '"."',
               'font-size': 0,
               'visibility': 'hidden',
               'display': 'inline-block', /* 1 */
               'overflow': 'hidden', /* 1 */
               'height': 0, /* 1 */
               'width': 0 /* 1 */
            }
        }
    }
];