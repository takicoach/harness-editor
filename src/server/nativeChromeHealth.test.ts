import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({launch:vi.fn(),connect:vi.fn(),decode:vi.fn()}));
vi.mock('playwright-core',()=>({chromium:{launchServer:mocks.launch,connect:mocks.connect}}));
vi.mock('./pngRgba',()=>({decodePngRgba:mocks.decode}));
import {checkNativeChromeHealth} from './nativeChromeHealth';
let server: {close:ReturnType<typeof vi.fn>;kill:ReturnType<typeof vi.fn>;process:ReturnType<typeof vi.fn>;wsEndpoint:()=>string},browser:{close:ReturnType<typeof vi.fn>;version:()=>string;newPage:ReturnType<typeof vi.fn>};
beforeEach(()=>{
 vi.useRealTimers();vi.clearAllMocks();server={close:vi.fn(async()=>{}),kill:vi.fn(async()=>{}),process:vi.fn(()=>({exitCode:0})),wsEndpoint:()=> 'ws://owned'};
 browser={close:vi.fn(async()=>{}),version:()=> '148.0.7778.96',newPage:vi.fn(async()=>({setDefaultTimeout(){},on(){},setContent:async()=>{},screenshot:async()=>Buffer.alloc(1)}))};
 mocks.launch.mockResolvedValue(server);mocks.connect.mockResolvedValue(browser);mocks.decode.mockReturnValue({width:2,height:2,data:Buffer.from(Array(4).fill([23,91,177,255]).flat())});
});
afterEach(()=>vi.useRealTimers());
it('uses the exact requested binary and closes both connection and owned server',async()=>{await checkNativeChromeHealth('/private/stage/chrome');expect(mocks.launch).toHaveBeenCalledWith({executablePath:'/private/stage/chrome',headless:true,timeout:30000});expect(browser.close).toHaveBeenCalledOnce();expect(server.close).toHaveBeenCalledOnce();});
it('rejects a launchable binary of the wrong version',async()=>{browser.version=()=> '147.0.0.0';await expect(checkNativeChromeHealth('/wrong')).rejects.toThrow('version-mismatch');expect(browser.close).toHaveBeenCalledOnce();expect(server.close).toHaveBeenCalledOnce();});
it('rejects wrong actual pixel bytes despite correct screenshot dimensions',async()=>{mocks.decode.mockReturnValue({width:2,height:2,data:Buffer.alloc(16)});await expect(checkNativeChromeHealth('/wrong-pixels')).rejects.toThrow('render-health-failed');expect(server.close).toHaveBeenCalledOnce();});
it('kills its owned process and rejects when page work never completes',async()=>{vi.useFakeTimers();browser.newPage.mockImplementation(()=>new Promise(()=>{}));const pending=expect(checkNativeChromeHealth('/hung')).rejects.toThrow('health-timeout');await vi.advanceTimersByTimeAsync(60001);await pending;expect(server.kill).toHaveBeenCalled();});
it('rejects and kills when graceful server close hangs',async()=>{vi.useFakeTimers();server.close.mockImplementation(()=>new Promise(()=>{}));const pending=expect(checkNativeChromeHealth('/close-hung')).rejects.toThrow('close-timeout');await vi.advanceTimersByTimeAsync(5001);await pending;expect(server.kill).toHaveBeenCalled();});
