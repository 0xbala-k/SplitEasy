import { showDialog } from '@/lib/dialog.web';

describe('showDialog (web)', () => {
  const alertMock = jest.fn();
  const confirmMock = jest.fn();

  beforeEach(() => {
    alertMock.mockReset();
    confirmMock.mockReset();
    (globalThis as Record<string, unknown>).window = Object.assign(
      (globalThis as { window?: object }).window ?? {},
      { alert: alertMock, confirm: confirmMock },
    );
  });

  it('uses alert and fires the single button for one-button dialogs', () => {
    const onPress = jest.fn();
    showDialog('Title', 'Message', [{ text: 'OK', onPress }]);
    expect(alertMock).toHaveBeenCalledWith('Title\n\nMessage');
    expect(onPress).toHaveBeenCalled();
  });

  it('uses alert with no buttons provided', () => {
    showDialog('Title', 'Message');
    expect(alertMock).toHaveBeenCalledWith('Title\n\nMessage');
  });

  it('fires the confirm (non-cancel) button when confirm returns true', () => {
    confirmMock.mockReturnValue(true);
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    showDialog('Delete?', 'Really?', [
      { text: 'Cancel', style: 'cancel', onPress: onCancel },
      { text: 'Delete', style: 'destructive', onPress: onConfirm },
    ]);
    expect(onConfirm).toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('fires the cancel button when confirm returns false', () => {
    confirmMock.mockReturnValue(false);
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    showDialog('Delete?', 'Really?', [
      { text: 'Cancel', style: 'cancel', onPress: onCancel },
      { text: 'Delete', style: 'destructive', onPress: onConfirm },
    ]);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });
});
